import { describe, it, expect, vi, beforeEach } from "vitest";

// Automated subscription changes must leave an audit trail.
//
// The defect: the lifecycle sweep is a timer/startup job with no request and no
// logged-in user, so it called logAudit() with actorType undefined. audit_logs
// declared actor_type ENUM('admin','user') NOT NULL, so the insert failed the
// constraint — and because logAudit is deliberately non-throwing ("losing an
// audit row is better than rolling back a customer's payment"), the row vanished
// into a console message. The result was that subscription.scheduled_change_applied
// and subscription.lapsed_to_free were NEVER recorded: the one billing path with
// no human in the loop was the one path with no audit trail.
//
// A second, quieter half: callers that passed actorType: "" appeared to work
// only because the server runs MariaDB without STRICT_TRANS_TABLES, so an
// out-of-enum value was coerced to '' instead of rejected. That stored
// actor_type='' / actor_id=0, neither of which exists in the schema, and would
// have become a hard failure for every webhook audit the moment strict mode was
// enabled.

const h = vi.hoisted(() => {
  const poolQuery = vi.fn();
  const connQuery = vi.fn();
  const auditCalls = [];
  const connection = {
    query: connQuery,
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
  return { poolQuery, connQuery, auditCalls, connection, getConnection: vi.fn(), notify: vi.fn() };
});

vi.mock("../src/config/db.js", () => ({
  pool: { query: h.poolQuery, getConnection: h.getConnection },
}));
vi.mock("../src/controllers/notification.controller.js", () => ({
  createNotificationForOrgUsers: (arg) => h.notify(arg),
}));
vi.mock("../src/utils/auditLog.js", () => ({
  logAudit: (arg) => h.auditCalls.push(arg),
  getActorFromReq: () => ({ actorType: "user", actorId: 1, actorName: "u", actorRole: "org_admin" }),
}));

import { applyDueSubscriptionChanges } from "../src/services/subscriptionLifecycle.service.js";

const BASIC = { id: 2, uuid: "plan-basic", name: "Basic", monthly_price: "10000.00", is_free: 0 };
const PRO = { id: 3, uuid: "plan-pro", name: "Professional", monthly_price: "30000.00", is_free: 0 };
const FREE = { id: 1, uuid: "plan-free", name: "Free", monthly_price: "0.00", is_free: 1, free_plan_guard: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  h.auditCalls.length = 0;
  h.connection.beginTransaction.mockResolvedValue(undefined);
  h.connection.commit.mockResolvedValue(undefined);
  h.connection.rollback.mockResolvedValue(undefined);
  h.connection.release.mockImplementation(() => {});
  h.getConnection.mockResolvedValue(h.connection);
  h.notify.mockResolvedValue(undefined);
});

/** The sweep's own queries, answered with one org mid-downgrade. */
function setupScheduledChange() {
  const dueOrg = {
    id: 7,
    uuid: "org-uuid",
    name: "Acme",
    subscription_plan_id: 3,
    subscription_status: "active",
    subscription_expiry: "2020-01-01 00:00:00",
    pending_plan_id: 2,
    subscription_start: "2020-01-01 00:00:00",
  };

  // The sweep selects its work through `executor` (the shared pool), not the
  // transaction connection, so the two have to be mocked separately.
  h.poolQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/pending_plan_id IS NOT NULL/.test(stmt)) return [[dueOrg]];
    if (/JOIN subscription_plans sp ON sp\.id = o\.subscription_plan_id/.test(stmt)) return [[]];
    if (/subscription_plan_id IS NULL/.test(stmt)) return [[]];
    return [[]];
  });

  h.connQuery.mockImplementation(async (sql) => {
    const stmt = String(sql);
    if (/^\s*SELECT/i.test(stmt)) {
      if (stmt.includes("FROM subscription_plans")) return [[BASIC]];
      if (stmt.includes("FROM organizations")) return [[dueOrg]];
      return [[]];
    }
    return [{ affectedRows: 1 }];
  });
}

const auditFor = (action) => h.auditCalls.find((a) => a.action === action);

describe("the lifecycle sweep records an auditable actor", () => {
  it("logs scheduled_change_applied with a system actor, not an absent one", async () => {
    setupScheduledChange();
    await applyDueSubscriptionChanges();

    const entry = auditFor("subscription.scheduled_change_applied");
    // The assertion that would have caught the bug: an entry that is not
    // recorded at all, or recorded without a usable actor_type, cannot be
    // written to a NOT NULL enum column and is dropped on the floor.
    expect(entry).toBeDefined();
    expect(entry.actorType).toBe("system");
    expect(["admin", "user", "system"]).toContain(entry.actorType);
  });

  it("never leaves actor_id as a fabricated 0", async () => {
    setupScheduledChange();
    await applyDueSubscriptionChanges();

    const entry = auditFor("subscription.scheduled_change_applied");
    // 0 is not a user. It is what a non-numeric source string coerces to, and it
    // reads in the audit trail exactly like a real user id.
    expect(entry.actorId ?? null).toBeNull();
  });

  it("identifies itself in actorName and records the transition detail", async () => {
    setupScheduledChange();
    await applyDueSubscriptionChanges();

    const entry = auditFor("subscription.scheduled_change_applied");
    expect(String(entry.actorName)).toMatch(/lifecycle|sweep|system/i);
    expect(entry.actorRole).toBe("system");
    // The details are what make the row useful after the fact.
    expect(entry.details).toMatchObject({
      from_plan_id: 3,
      to_plan_id: 2,
    });
  });

  it("emits no audit entry with a missing or out-of-enum actor_type", async () => {
    setupScheduledChange();
    await applyDueSubscriptionChanges();

    // A general guard over every entry the sweep emits, not just this one: an
    // out-of-enum value is what strict mode would later reject.
    for (const entry of h.auditCalls) {
      expect(entry.actorType).toBeTruthy();
      expect(["admin", "user", "system"]).toContain(entry.actorType);
      expect(entry.actorId === undefined || entry.actorId === null || Number.isInteger(entry.actorId)).toBe(true);
    }
  });
});

describe("subscription.applied never stores a code path in the user id column", () => {
  it("uses null for actor_id and keeps the source as a label", async () => {
    const { logSubscriptionChangeApplied } = await import("../src/utils/subscriptionTransition.js");

    logSubscriptionChangeApplied({
      orgUuid: "org-uuid",
      organizationId: 7,
      change: { action: "activate_now", relation: "activation" },
      source: "safepay_webhook",
    });

    const entry = h.auditCalls.find((a) => a.action === "subscription.applied");
    expect(entry).toBeDefined();
    expect(entry.actorType).toBe("system");
    // The bug: `actorId: source` put the string "safepay_webhook" into an INT
    // column, which only ever became actor_id=0 by silent coercion.
    expect(entry.actorId ?? null).toBeNull();
    expect(entry.actorName).toBe("safepay_webhook");
    expect(entry.details.source).toBe("safepay_webhook");
  });

  it("still prefers an explicit human actor when one is supplied", async () => {
    const { logSubscriptionChangeApplied } = await import("../src/utils/subscriptionTransition.js");

    logSubscriptionChangeApplied({
      orgUuid: "org-uuid",
      organizationId: 7,
      change: { action: "upgrade_now" },
      source: "admin_override",
      actor: { actorType: "admin", actorId: 9, actorName: "Platform Admin", actorRole: "system_admin" },
    });

    const entry = h.auditCalls.find((a) => a.action === "subscription.applied");
    expect(entry.actorType).toBe("admin");
    expect(entry.actorId).toBe(9);
  });
});
