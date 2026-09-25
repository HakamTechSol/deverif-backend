import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { sendExpiryReminderEmail } from "../../utils/mailer.js";
import { createNotificationForOrgUsers } from "../notification.controller.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { assignFreePlanToOrg } from "../../utils/freePlan.js";
import { resetDailyRequestUsage } from "../../utils/requestQuota.js";

const ORG_SELECT = `organizations.id, organizations.uuid, organizations.name, organizations.verified,
  organizations.logo, ot.name AS organization_type, organizations.business_email,
  organizations.subscription_status, organizations.subscription_start, organizations.subscription_expiry,
  organizations.subscription_plan_id,
  (SELECT name FROM subscription_plans sp WHERE sp.id = organizations.subscription_plan_id) AS subscription_plan_name,
  organizations.reminder_2d_sent, organizations.reminder_2h_sent, organizations.created_at`;

  const ORG_LIST_SELECT = `${ORG_SELECT},
  (SELECT COUNT(*) FROM users u WHERE u.organization = organizations.id AND u.deleted_at IS NULL) AS users_count,
  (SELECT COUNT(*) FROM employees e WHERE e.organization_id = organizations.id AND e.record_type='roster') AS employees_count,
  (SELECT COUNT(*) FROM verification_requests vr WHERE vr.issuing_organization_id = organizations.id) AS requests_count,
  (SELECT u.full_name FROM users u WHERE u.organization = organizations.id AND u.org_role = 'org_admin' AND u.deleted_at IS NULL ORDER BY u.id ASC LIMIT 1) AS admin_name,
  (SELECT u.email FROM users u WHERE u.organization = organizations.id AND u.org_role = 'org_admin' AND u.deleted_at IS NULL ORDER BY u.id ASC LIMIT 1) AS admin_email`;

  const ORG_TYPE_JOIN = " LEFT JOIN organization_types ot ON ot.id = organizations.organization_type ";

export async function listOrganizations(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const withoutAdmin = req.query.without_admin === "1" || req.query.without_admin === "true";

  let whereClause = "WHERE deleted_at IS NULL";
  const params = [];

  if (search) {
    whereClause += ` AND (organizations.name LIKE ? OR ot.name LIKE ?)`;
    const like = `%${search}%`;
    params.push(like, like);
  }

  // Only show organizations that do NOT have an org_admin yet (used by the
  // system admin "Add user" dropdown so existing admin'd orgs are excluded).
  if (withoutAdmin) {
    whereClause += ` AND NOT EXISTS (
      SELECT 1 FROM users u
      WHERE u.organization = organizations.id
        AND u.org_role = 'org_admin'
    )`;
  }

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM organizations ${ORG_TYPE_JOIN} ${whereClause}`, params);
  const [rows] = await pool.query(`SELECT ${ORG_LIST_SELECT} FROM organizations ${ORG_TYPE_JOIN} ${whereClause} ORDER BY organizations.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

  await Promise.all(rows.map(expireIfNeeded));

  // Lazy check for expiry reminders (runs on every admin org list request)
  checkAndSendExpiryReminders().catch(() => {});

  return ok(res, paginatedResponse(rows, total, page, limit), "Organizations list");
}

async function expireIfNeeded(org) {
  if (org.subscription_status === "active" && org.subscription_expiry && new Date(org.subscription_expiry) < new Date()) {
    org.subscription_status = "expired";
    await pool.query("UPDATE organizations SET subscription_status='expired' WHERE id=?", [org.id]);
  }
}

export async function assertOrganizationActive(orgId) {
  const [[org]] = await pool.query("SELECT subscription_status, subscription_expiry FROM organizations WHERE id=?", [orgId]);
  if (!org) return;
  await expireIfNeeded(org);
  if (org.subscription_status !== "active") {
    throw new ApiError(403, "Organization subscription is inactive. Please contact admin to renew.");
  }
}

async function resolveOrgTypeId(name) {
  if (!name) return null;
  const [rows] = await pool.query("SELECT id FROM organization_types WHERE LOWER(name)=LOWER(?) ORDER BY id DESC LIMIT 1", [String(name).trim()]);
  return rows.length ? rows[0].id : null;
}

export async function createOrganization(req, res) {
  const { name, organization_type, business_email } = req.body;
  if (!name) throw new ApiError(400, "name is required");

  const logoPath = req.file ? `uploads/organizations/${req.file.filename}` : null;

  const email = business_email ? String(business_email).trim() : null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "business_email must be a valid email address");
  }

  const typeId = await resolveOrgTypeId(organization_type);

  const [result] = await pool.query(
    "INSERT INTO organizations (name, verified, logo, organization_type, business_email) VALUES (?, 'yes', ?, ?, ?)",
    [name, logoPath, typeId, email]
  );

  // Automatically subscribe new orgs to the Free plan (baseline experience).
  await assignFreePlanToOrg(pool, result.insertId);

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations ${ORG_TYPE_JOIN} WHERE organizations.id=?`, [result.insertId]);

  logAudit({
    ...getActorFromReq(req),
    action: "organization.create",
    entityType: "organization",
    entityId: rows[0].uuid,
    details: { name, organization_type: rows[0].organization_type },
    req,
  });

  return created(res, { organization: rows[0] }, "Organization created");
}

export async function updateOrganization(req, res) {
  const { uuid } = req.params;
  const { name, organization_type, business_email } = req.body;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (organization_type !== undefined && organization_type !== null && String(organization_type).trim() !== "") {
    updates.organization_type = await resolveOrgTypeId(String(organization_type).trim());
  }
  if (business_email !== undefined) {
    const email = String(business_email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, "business_email must be a valid email address");
    }
    updates.business_email = email || null;
  }
  if (req.file) updates.logo = `uploads/organizations/${req.file.filename}`;

  if (!Object.keys(updates).length) throw new ApiError(400, "At least one field is required to update");

  const fields = Object.keys(updates).map((k) => `${k}=?`).join(", ");
  const values = Object.values(updates);

  await pool.query(`UPDATE organizations SET ${fields} WHERE uuid=?`, [...values, uuid]);

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations ${ORG_TYPE_JOIN} WHERE organizations.uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "organization.update",
    entityType: "organization",
    entityId: uuid,
    details: { fields: Object.keys(updates) },
    req,
  });

  return ok(res, { organization: rows[0] }, "Organization updated successfully");
}

export async function listOrganizationTypes(req, res) {
  const [rows] = await pool.query(
    "SELECT id, name, created_at FROM organization_types ORDER BY name ASC"
  );
  return ok(res, { items: rows }, "Organization types list");
}

export async function createOrganizationType(req, res) {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) throw new ApiError(400, "name is required");
  if (name.length > 100) throw new ApiError(400, "name must be 100 characters or fewer");

  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  try {
    const [result] = await pool.query(
      "INSERT INTO organization_types (name) VALUES (?)",
      [normalized]
    );
    const [rows] = await pool.query(
      "SELECT id, name, created_at FROM organization_types WHERE id=?",
      [result.insertId]
    );

    logAudit({
      ...getActorFromReq(req),
      action: "organization_type.create",
      entityType: "organization_type",
      entityId: String(result.insertId),
      details: { name: normalized },
      req,
    });

    return created(res, { organization_type: rows[0] }, "Organization type created");
  } catch (e) {
    if (String(e.message).includes("Duplicate")) {
      throw new ApiError(409, "This organization type already exists");
    }
    throw e;
  }
}

export async function deleteOrganizationType(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) throw new ApiError(400, "Invalid organization type id");

  const [[type]] = await pool.query("SELECT id, name FROM organization_types WHERE id=?", [id]);
  if (!type) throw new ApiError(404, "Organization type not found");

  const [[{ count }]] = await pool.query(
    "SELECT COUNT(*) AS count FROM organizations WHERE organization_type=?",
    [id]
  );
  if (count > 0) {
    throw new ApiError(409, `Cannot delete this type — it is assigned to ${count} organization(s). Reassign those organizations first.`);
  }

  await pool.query("DELETE FROM organization_types WHERE id=?", [id]);

  logAudit({
    ...getActorFromReq(req),
    action: "organization_type.delete",
    entityType: "organization_type",
    entityId: String(id),
    details: { name: type.name },
    req,
  });

  return ok(res, { deleted: true }, "Organization type deleted");
}

export async function deleteOrganization(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query(
    "SELECT id FROM organizations WHERE uuid=? AND deleted_at IS NULL",
    [uuid]
  );
  if (!orgExists.length) throw new ApiError(404, "Organization not found");
  const orgId = orgExists[0].id;

  const [[{ assignedUsers }]] = await pool.query(
    "SELECT COUNT(*) AS assignedUsers FROM users WHERE organization=? AND deleted_at IS NULL",
    [orgId]
  );
  const [[{ assignedRequests }]] = await pool.query(
    "SELECT COUNT(*) AS assignedRequests FROM verification_requests WHERE issuing_organization_id=?",
    [orgId]
  );
  if (Number(assignedUsers) > 0 || Number(assignedRequests) > 0) {
    throw new ApiError(409, "This organization is assigned to users or verification requests and cannot be deleted");
  }

  await pool.query(
    "UPDATE organizations SET deleted_at = NOW() WHERE uuid=? AND deleted_at IS NULL",
    [uuid]
  );

  logAudit({
    ...getActorFromReq(req),
    action: "organization.delete",
    entityType: "organization",
    entityId: uuid,
    req,
  });

  return ok(res, {}, "Organization deleted successfully");
}

export async function setOrganizationSubscription(req, res) {
  const { uuid } = req.params;
  const { plan, amount, plan_uuid } = req.body;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query("SELECT id, uuid FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  // Resolve the plan to assign: either a specific plan_uuid or the legacy
  // monthly/yearly shortcut (monthly -> Plan A, yearly -> Plan B).
  // plan_uuid may reference standard (is_custom=0) OR custom (is_custom=1)
  // plans, so custom plans can be (re)assigned to their own organization.
  let planRow;
  let billingPeriod;
  if (plan_uuid) {
    assertUuid(plan_uuid, "Plan UUID");
    const [[row]] = await pool.query(
      `SELECT id, name, monthly_price, billing_period FROM subscription_plans WHERE uuid=?`,
      [plan_uuid]
    );
    if (!row) {
      throw new ApiError(404, "Plan not found");
    }
    planRow = row;
    billingPeriod = row.billing_period;
  } else {
    if (!["monthly", "yearly"].includes(plan)) {
      throw new ApiError(400, "plan must be 'monthly' or 'yearly', or pass plan_uuid");
    }
    const planName = plan === "monthly" ? "Plan A" : "Plan B";
    const [[row]] = await pool.query(
      "SELECT id, name, monthly_price, billing_period FROM subscription_plans WHERE name=? AND is_custom=0 ORDER BY id ASC LIMIT 1",
      [planName]
    );
    if (!row) throw new ApiError(500, `Subscription plan "${planName}" is not seeded`);
    planRow = row;
    billingPeriod = row.billing_period || plan;
  }

  const orgId = orgExists[0].id;
  const now = new Date();
  const durationMonths = billingPeriod === "yearly" ? 12 : 1;
  const expiry = new Date(now);
  expiry.setMonth(expiry.getMonth() + durationMonths);

  await pool.query(
    `UPDATE organizations SET subscription_status='active', subscription_start=?, subscription_expiry=?, subscription_plan_id=?, reminder_2d_sent='no', reminder_2h_sent='no' WHERE id=?`,
    [now, expiry, planRow.id, orgId]
  );

  // Assigning a plan is a new entitlement: clear today's usage so the org gets
  // the full daily quota of the plan just assigned instead of the new quota
  // minus what it already consumed today under its previous plan.
  await resetDailyRequestUsage(orgId);

  // A manually-assigned plan supersedes any pending self-subscription request.
  await pool.query(
    `UPDATE self_subscription_requests SET status='cancelled', decided_by=?, decided_at=NOW()
     WHERE organization_id=? AND status='pending'`,
    [req.admin?.uuid ?? null, orgId]
  );

  // Record payment only if an amount was provided
  const numericAmount = Number(amount);
  if (numericAmount > 0) {
    const [[firstUser]] = await pool.query(
      "SELECT id FROM users WHERE organization=? ORDER BY created_at ASC LIMIT 1",
      [orgId]
    );
    if (firstUser) {
      await pool.query(
        `INSERT INTO payment (user_id, amount, payment_method, transaction_reference, paid_at, purpose) VALUES (?, ?, 'manual', ?, NOW(), ?)`,
        [firstUser.id, numericAmount, `SUB-${planRow.name.replace(/\s+/g, "-").toUpperCase()}-${Date.now()}`, `Subscription: ${planRow.name} for organization`]
      );
    }
  }

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations ${ORG_TYPE_JOIN} WHERE organizations.uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "subscription.set",
    entityType: "organization",
    entityId: uuid,
    details: { plan: planRow.name, plan_uuid: plan_uuid || null, amount: numericAmount > 0 ? numericAmount : null },
    req,
  });

  return ok(res, { organization: rows[0] }, `Subscription set to ${planRow.name} (expires ${expiry.toISOString().slice(0, 10)})`);
}

export async function cancelOrganizationSubscription(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  await pool.query(
    `UPDATE organizations SET subscription_status='none', subscription_start=NULL, subscription_expiry=NULL, subscription_plan_id=NULL WHERE id=?`,
    [orgExists[0].id]
  );

  // Cancelling the subscription voids any pending self-subscription request.
  await pool.query(
    `UPDATE self_subscription_requests SET status='cancelled', decided_by=?, decided_at=NOW()
     WHERE organization_id=? AND status='pending'`,
    [req.admin?.uuid ?? null, orgExists[0].id]
  );

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations ${ORG_TYPE_JOIN} WHERE organizations.uuid=?`, [uuid]);

  logAudit({
    ...getActorFromReq(req),
    action: "subscription.cancel",
    entityType: "organization",
    entityId: uuid,
    req,
  });

  return ok(res, { organization: rows[0] }, "Subscription cancelled");
}

export async function checkAndSendExpiryReminders() {
  try {
    // Orgs with an active subscription that expires within the next 3 days.
    const [orgs] = await pool.query(
      `SELECT id, uuid, name, business_email, subscription_expiry, last_expiry_reminder_sent
       FROM organizations
       WHERE subscription_status='active'
         AND subscription_expiry IS NOT NULL
         AND subscription_expiry > NOW()
         AND subscription_expiry <= DATE_ADD(NOW(), INTERVAL 3 DAY)`
    );

    const today = new Date().toISOString().slice(0, 10);

    for (const org of orgs) {
      const expiryDate = new Date(String(org.subscription_expiry).replace(" ", "T"));
      if (isNaN(expiryDate.getTime())) continue;

      // Send at most once per day to avoid spam (daily from 3 days before).
      if (org.last_expiry_reminder_sent === today) continue;

      const msLeft = expiryDate.getTime() - Date.now();
      const daysLeft = Math.max(1, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));

      // Recipients: company business email + all org admin emails, deduped.
      const recipients = new Map();
      if (org.business_email) recipients.set(org.business_email, "en");

      const [admins] = await pool.query(
        `SELECT email, preferred_language
         FROM users
         WHERE organization=? AND org_role='org_admin'
           AND status='active' AND deleted_at IS NULL`,
        [org.id]
      );
      for (const admin of admins) {
        if (admin.email) {
          recipients.set(admin.email, admin.preferred_language === "ur" ? "ur" : "en");
        }
      }

      if (recipients.size === 0) {
        // Nothing to mail to; still record the send so we don't retry forever.
        await pool.query(
          "UPDATE organizations SET last_expiry_reminder_sent=? WHERE id=?",
          [today, org.id]
        );
        continue;
      }

      await sendExpiryReminderEmail({
        to: [...recipients.keys()],
        orgName: org.name,
        daysLeft,
        type: "2d",
      }).catch(() => {});

      await createNotificationForOrgUsers({
        orgId: org.id,
        type: "expiry_warning",
        title: "Subscription expiring soon",
        message: `Your organization's subscription expires in ${daysLeft} day(s). Contact admin to renew.`,
        link: "/payments",
        orgRoles: ["org_admin"],
      }).catch(() => {});

      await pool.query(
        "UPDATE organizations SET last_expiry_reminder_sent=? WHERE id=?",
        [today, org.id]
      );
    }
  } catch (err) {
    console.error("Error checking expiry reminders:", err.message);
  }
}