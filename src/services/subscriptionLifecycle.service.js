import { pool } from "../config/db.js";
import { expiryForPlan, PLAN_SELECT_COLUMNS } from "../utils/subscriptionTransition.js";
import { getFreePlan } from "../utils/subscriptionPlans.js";
import { logAudit } from "../utils/auditLog.js";
import { createNotificationForOrgUsers } from "../controllers/notification.controller.js";

/**
 * Actor for a change the PLATFORM made rather than a person.
 *
 * The sweep runs on a timer and at startup, with no request and no logged-in
 * user, so there is genuinely nobody to attribute these to. That is exactly why
 * `actor_type` carries a 'system' member: without it the insert failed the
 * NOT NULL constraint, and because logAudit is deliberately non-throwing the row
 * vanished into a console message — leaving the one automated billing path in
 * the product with no audit trail at all.
 *
 * `actor_id` is null rather than 0 because 0 is not a user; it only looked
 * acceptable while strict SQL mode was off and out-of-range values were being
 * coerced instead of rejected.
 */
const SYSTEM_ACTOR = Object.freeze({
  actorType: "system",
  actorId: null,
  actorName: "subscription_lifecycle_sweep",
  actorRole: "system",
});

/**
 * Periodic subscription maintenance -- the single sweep behind the interval in
 * src/server.js (which also runs checkAndSendExpiryReminders).
 *
 * It resolves BOTH ways an organization's plan can change at the end of a paid
 * period, in one pass:
 *
 *   1. Scheduled change (organizations.pending_plan_id is set)
 *      The org deliberately bought a different plan while its current period was
 *      still running. When that period ends the new plan takes over, starting
 *      from the old expiry so no paid time is lost.
 *
 *   2. Unplanned lapse (paid plan past its expiry, nothing scheduled)
 *      Nobody arranged a change, so rather than leaving the org parked in
 *      subscription_status='expired' limbo it falls back to the Free plan,
 *      which is a real plan with no expiry.
 *
 * The two branches are mutually exclusive by construction: (1) requires
 * pending_plan_id IS NOT NULL, (2) requires it IS NULL, and (2) also requires
 * the current plan to be non-Free. An org therefore can never be processed by
 * both in the same sweep, and a deliberate downgrade-to-Free lands through (1)
 * rather than being short-circuited by (2).
 *
 * Re-entrancy: each org is claimed inside its own transaction, the row is locked
 * FOR UPDATE, the due-ness is re-checked under that lock, and the UPDATE is
 * additionally guarded on the state it observed. Two overlapping runs (the hourly
 * tick plus a manual trigger) therefore cannot double-apply anything.
 */

const BATCH_LIMIT = 500;

export async function applyDueSubscriptionChanges({ executor = pool } = {}) {
  const [dueOrgs] = await executor.query(
    `SELECT id, uuid, name, pending_plan_id, subscription_expiry
     FROM organizations
     WHERE pending_plan_id IS NOT NULL
       AND subscription_expiry IS NOT NULL
       AND subscription_expiry <= NOW()
       AND deleted_at IS NULL
     ORDER BY id ASC
     LIMIT ${BATCH_LIMIT}`
  );

  // Paid subscriptions that have run out with no scheduled change. is_free = 0
  // keeps orgs already on Free out of the result, and NULL expiry already
  // excludes them, so this is only ever about lapsed PAID plans.
  const [lapsedPaidOrgs] = await executor.query(
    `SELECT o.id, o.uuid, o.name, o.subscription_expiry, sp.id AS plan_id, sp.name AS plan_name
     FROM organizations o
     JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
     WHERE o.subscription_expiry IS NOT NULL
       AND o.subscription_expiry <= NOW()
       AND o.pending_plan_id IS NULL
       AND sp.is_free = 0
       AND o.deleted_at IS NULL
     ORDER BY o.id ASC
     LIMIT ${BATCH_LIMIT}`
  );

  const scheduled = [];
  const lapsed = [];
  const repaired = [];
  const failed = [];

  for (const org of dueOrgs) {
    try {
      const outcome = await applyScheduledChange(org);
      if (outcome) scheduled.push(outcome);
    } catch (error) {
      // One bad org must never stop the rest of the batch.
      console.error(`Error applying scheduled plan change for organization ${org.id}:`, error?.message);
      failed.push({ organization_id: org.id, kind: "scheduled", error: error?.message || String(error) });
    }
  }

  for (const org of lapsedPaidOrgs) {
    try {
      const outcome = await applyLapseToFree(org);
      if (outcome) lapsed.push(outcome);
    } catch (error) {
      console.error(`Error falling organization ${org.id} back to Free:`, error?.message);
      failed.push({ organization_id: org.id, kind: "lapsed_to_free", error: error?.message || String(error) });
    }
  }

  try {
    const outcome = await repairPlanlessOrganizations({ executor });
    repaired.push(...outcome.repaired);
    failed.push(...outcome.failed);
  } catch (error) {
    console.error("Error repairing planless organizations:", error?.message);
  }

  if (scheduled.length || lapsed.length || repaired.length) {
    console.log(
      `[subscription] applied ${scheduled.length} scheduled plan change(s), ` +
        `${lapsed.length} lapse(s) to Free, repaired ${repaired.length} planless org(s)`
    );
  }
  if (failed.length) {
    console.error(`[subscription] ${failed.length} subscription change(s) failed to apply`);
  }

  return { scheduled, lapsed, repaired, failed };
}

/** Backwards-compatible alias for the original (single-branch) export name. */
export const applyDueSubscriptionDowngrades = applyDueSubscriptionChanges;

/* ─────────────────────── branch 1: scheduled change ─────────────────────── */

async function applyScheduledChange(org) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[locked]] = await connection.query(
      `SELECT id, uuid, name, subscription_status, subscription_plan_id, pending_plan_id, subscription_expiry
       FROM organizations
       WHERE id=?
       FOR UPDATE`,
      [org.id]
    );
    if (!locked || locked.pending_plan_id == null) {
      await connection.rollback();
      return null;
    }

    // Re-check under the lock: another run may have applied it already.
    if (!locked.subscription_expiry || new Date(locked.subscription_expiry) > new Date()) {
      await connection.rollback();
      return null;
    }

    const [[plan]] = await connection.query(
      `SELECT ${PLAN_SELECT_COLUMNS} FROM subscription_plans WHERE id=?`,
      [locked.pending_plan_id]
    );
    if (!plan) {
      // The pending plan was deleted (ON DELETE SET NULL normally prevents
      // this, but a manual DB edit could get here). Drop the dangling intent
      // rather than retrying it every hour forever.
      await connection.query(
        "UPDATE organizations SET pending_plan_id=NULL WHERE id=? AND pending_plan_id=?",
        [locked.id, locked.pending_plan_id]
      );
      await connection.commit();
      return null;
    }

    // The new period starts where the previous one ended, so the org does not
    // lose any time it already paid for. The Free plan has no billing cycle, so
    // expiryForPlan returns NULL for it -- "indefinite", not "expired".
    //
    // This is the ONE path for every scheduled change. It does not care whether
    // pending_plan_id differs from subscription_plan_id:
    //   downgrade -> plan switches, expiry = old_expiry + that plan's period
    //   renewal   -> plan is unchanged, expiry = old_expiry + current period
    // Both are "start the new period where the old one ended", which is exactly
    // the arithmetic above, so no branch is needed for the same-plan case.
    const newExpiry = expiryForPlan(plan, locked.subscription_expiry);
    const isRenewal = Number(plan.id) === Number(locked.subscription_plan_id);

    const [result] = await connection.query(
      `UPDATE organizations
       SET subscription_plan_id=?, subscription_expiry=?, subscription_status='active',
           pending_plan_id=NULL, reminder_2d_sent='no', reminder_2h_sent='no'
       WHERE id=? AND pending_plan_id=?`,
      [plan.id, newExpiry, locked.id, locked.pending_plan_id]
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return null;
    }

    await connection.commit();

    logAudit({
      ...SYSTEM_ACTOR,
      // Named for the mechanism, not only the downgrade case: a scheduled
      // renewal lands here too, and filing it as "downgrade_applied" would make
      // the audit trail misdescribe a renewal as a plan reduction.
      action: "subscription.scheduled_change_applied",
      entityType: "organization",
      entityId: locked.uuid,
      details: {
        kind: isRenewal ? "renewal" : "plan_change",
        from_plan_id: locked.subscription_plan_id,
        to_plan_id: plan.id,
        applied_at_expiry: locked.subscription_expiry,
        new_expiry: newExpiry,
      },
    });

    const onFree = newExpiry == null;
    createNotificationForOrgUsers({
      orgId: locked.id,
      type: "subscription_plan_changed",
      title: onFree
        ? "Your plan is now Free"
        : isRenewal
          ? "Your plan has been renewed"
          : "Plan changed",
      message: onFree
        ? "Your previous plan has ended. Your organization is now on the Free plan (1 request per day). You can upgrade again at any time."
        : isRenewal
          ? `Your plan is now renewed on ${plan.name} (expires ${new Date(newExpiry).toISOString().slice(0, 10)}).`
          : `Your plan is now ${plan.name} (expires ${new Date(newExpiry).toISOString().slice(0, 10)}).`,
      link: "/payments",
      orgRoles: ["org_admin"],
    }).catch(() => {});

    return {
      organization_id: locked.id,
      organization_uuid: locked.uuid,
      kind: isRenewal ? "renewal" : "plan_change",
      plan_id: plan.id,
      plan_name: plan.name,
      previous_plan_id: locked.subscription_plan_id,
      previous_expiry: locked.subscription_expiry,
      new_expiry: newExpiry,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/* ──────────────── integrity net: heal orgs left planless ──────────────── */
/**
 * Every organization must always be on a real plan. This branch is the safety
 * net for when that invariant is broken by something OTHER than the normal
 * flows -- which has happened: an unexplained mutation once left organizations
 * with subscription_plan_id=NULL and a non-active status, and nothing in the
 * codebase logs those fields on write, so there was no way to tell what had
 * done it or to notice it.
 *
 * It is deliberately narrow so it can never fight the legitimate states:
 *   - an org with a pending_plan_id is left alone (a deliberate downgrade is
 *     being resolved by the branch above)
 *   - an org on a real plan with a lapsed paid expiry is left alone (that is
 *     the lapsed-to-Free branch's job)
 *   - a 'pending_payment' org that still HAS its plan is left alone (a genuine
 *     self-subscription awaiting admin confirmation)
 * Only genuinely planless/incoherent rows are touched, and every repair is
 * recorded in audit_logs with the exact prior state, so a recurrence is both
 * self-healing and traceable.
 */
async function repairPlanlessOrganizations({ executor }) {
  const repaired = [];
  const failed = [];

  const [rows] = await executor.query(
    `SELECT o.id, o.uuid, o.name, o.subscription_status, o.subscription_plan_id,
            o.subscription_start, o.subscription_expiry
     FROM organizations o
     WHERE o.deleted_at IS NULL
       AND o.pending_plan_id IS NULL
       AND (
         -- No plan at all: nothing legitimate produces this any more.
         o.subscription_plan_id IS NULL
         -- 'none' means "no subscription" which is no longer a reachable state.
         OR o.subscription_status = 'none'
       )
     ORDER BY o.id ASC
     LIMIT ${BATCH_LIMIT}`
  );
  if (!rows.length) return { repaired, failed };

  const freePlan = await getFreePlan(pool);

  for (const org of rows) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [[locked]] = await connection.query(
        `SELECT id, uuid, name, subscription_status, subscription_plan_id,
                subscription_start, subscription_expiry, pending_plan_id
         FROM organizations WHERE id=? FOR UPDATE`,
        [org.id]
      );
      // Re-check under the lock: the org may have been legitimately fixed or
      // may have acquired a scheduled change in the meantime.
      if (
        !locked ||
        locked.pending_plan_id != null ||
        (locked.subscription_plan_id != null && locked.subscription_status !== "none")
      ) {
        await connection.rollback();
        continue;
      }

      const keepsPlan = locked.subscription_plan_id != null;
      const planId = keepsPlan ? locked.subscription_plan_id : freePlan.id;

      const [result] = await connection.query(
        `UPDATE organizations
         SET subscription_status='active', subscription_plan_id=?, pending_plan_id=NULL,
             subscription_start=COALESCE(subscription_start, NOW()),
             subscription_expiry=CASE WHEN ? THEN NULL ELSE subscription_expiry END,
             reminder_2d_sent='no', reminder_2h_sent='no'
         WHERE id=? AND pending_plan_id IS NULL`,
        [planId, keepsPlan ? 0 : 1, locked.id]
      );
      if (!result.affectedRows) {
        await connection.rollback();
        continue;
      }

      await connection.commit();

      logAudit({
        ...SYSTEM_ACTOR,
        action: "subscription.integrity_repaired",
        entityType: "organization",
        entityId: locked.uuid,
        details: {
          reason: "org_left_planless_or_none_status",
          before: {
            status: locked.subscription_status,
            plan_id: locked.subscription_plan_id,
            expiry: locked.subscription_expiry,
          },
          after: {
            status: "active",
            plan_id: planId,
            assigned_free_plan: !keepsPlan,
            free_plan_id: freePlan.id,
          },
        },
      });

      console.warn(
        `[subscription] REPAIRED organization ${locked.id} (${locked.name}): ` +
          `${locked.subscription_status}/plan=${locked.subscription_plan_id} -> active/plan=${planId}`
      );

      repaired.push({
        organization_id: locked.id,
        organization_uuid: locked.uuid,
        from_status: locked.subscription_status,
        from_plan_id: locked.subscription_plan_id,
        to_plan_id: planId,
        assigned_free_plan: !keepsPlan,
      });
    } catch (error) {
      await connection.rollback();
      console.error(`Error repairing organization ${org.id}:`, error?.message);
      failed.push({ organization_id: org.id, kind: "integrity_repair", error: error?.message || String(error) });
    } finally {
      connection.release();
    }
  }

  return { repaired, failed };
}

/* ──────────────────── branch 2: lapsed paid plan -> Free ──────────────────── */

async function applyLapseToFree(org) {
  // The Free plan is looked up dynamically (never a hardcoded id/name/price) so
  // recreating or renaming it needs no code change.
  const freePlan = await getFreePlan(pool);
  if (Number(org.plan_id) === Number(freePlan.id)) return null;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[locked]] = await connection.query(
      `SELECT o.id, o.uuid, o.name, o.subscription_status, o.subscription_plan_id,
              o.subscription_expiry, o.pending_plan_id, sp.is_free
       FROM organizations o
       LEFT JOIN subscription_plans sp ON sp.id = o.subscription_plan_id
       WHERE o.id=?
       FOR UPDATE`,
      [org.id]
    );
    if (!locked) {
      await connection.rollback();
      return null;
    }

    // Everything that would make this a no-op has to be re-checked under the
    // lock: a scheduled change appeared, someone renewed, or the org is already
    // on Free. This is also what stops the two branches double-firing.
    if (locked.pending_plan_id != null) {
      await connection.rollback();
      return null;
    }
    if (Number(locked.is_free) === 1) {
      await connection.rollback();
      return null;
    }
    if (!locked.subscription_expiry || new Date(locked.subscription_expiry) > new Date()) {
      await connection.rollback();
      return null;
    }

    const [result] = await connection.query(
      `UPDATE organizations
       SET subscription_plan_id=?, subscription_status='active',
           subscription_expiry=NULL, subscription_start=NOW(),
           reminder_2d_sent='no', reminder_2h_sent='no'
       WHERE id=? AND pending_plan_id IS NULL AND subscription_plan_id=? AND subscription_expiry IS NOT NULL AND subscription_expiry <= NOW()`,
      [freePlan.id, locked.id, locked.subscription_plan_id]
    );

    if (!result.affectedRows) {
      await connection.rollback();
      return null;
    }

    await connection.commit();

      logAudit({
        ...SYSTEM_ACTOR,
        action: "subscription.lapsed_to_free",
      entityType: "organization",
      entityId: locked.uuid,
      details: {
        lapsed_plan_id: locked.subscription_plan_id,
        lapsed_at: locked.subscription_expiry,
        new_plan_id: freePlan.id,
        new_plan_name: freePlan.name,
      },
    });

    createNotificationForOrgUsers({
      orgId: locked.id,
      type: "subscription_lapsed_to_free",
      title: "Your plan has expired",
      message: `Your paid plan has ended, so your organization is now on the ${freePlan.name} plan (1 request per day). Upgrade any time to restore your previous limits.`,
      link: "/payments",
      orgRoles: ["org_admin"],
    }).catch(() => {});

    return {
      organization_id: locked.id,
      organization_uuid: locked.uuid,
      previous_plan_id: locked.subscription_plan_id,
      previous_expiry: locked.subscription_expiry,
      new_plan_id: freePlan.id,
      new_plan_name: freePlan.name,
      new_expiry: null,
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
