import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { normalizePlanFeatures } from "../../utils/planFeatures.js";

const PLAN_SELECT = `id, uuid, name, monthly_price, daily_request_quota,
  description, features, billing_period, is_public, is_custom, created_at, updated_at`;

function normalizePlan(row) {
  if (!row) return row;
  return {
    ...row,
    monthly_price: Number(row.monthly_price),
    daily_request_quota: Number(row.daily_request_quota),
    is_public: Number(row.is_public),
    is_custom: Number(row.is_custom),
    features: normalizePlanFeatures(row.features),
  };
}

function validatePlanBody(body, { partial = false } = {}) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new ApiError(400, "name is required");
    if (name.length > 120) throw new ApiError(400, "name must be 120 characters or fewer");
    out.name = name;
  }

  if (has("monthly_price")) {
    const price = Number(body.monthly_price);
    if (!Number.isFinite(price) || price < 0) {
      throw new ApiError(400, "monthly_price must be a non-negative number");
    }
    out.monthly_price = price.toFixed(2);
  }

  if (has("daily_request_quota")) {
    const quota = Number(body.daily_request_quota);
    if (!Number.isInteger(quota) || quota < 0) {
      throw new ApiError(400, "daily_request_quota must be a non-negative integer");
    }
    out.daily_request_quota = quota;
  }

  if (has("description")) {
    out.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }

  if (has("features")) {
    const features = normalizePlanFeatures(body.features);
    out.features = JSON.stringify(features);
  }

  if (has("billing_period")) {
    if (!["monthly", "yearly"].includes(body.billing_period)) {
      throw new ApiError(400, "billing_period must be 'monthly' or 'yearly'");
    }
    out.billing_period = body.billing_period;
  }

  if (has("is_public")) {
    out.is_public = body.is_public ? 1 : 0;
  }

  if (!partial && !out.name) throw new ApiError(400, "name is required");
  return out;
}

/** Admin: list all plans (optionally filtered by ?public=1). */
export async function listPlans(req, res) {
  const isPublic = typeof req.query.public === "string" ? Number(req.query.public) : null;
  const where = isPublic != null ? "WHERE is_public=?" : "";
  const params = isPublic != null ? [isPublic ? 1 : 0] : [];
  const [rows] = await pool.query(
    `SELECT ${PLAN_SELECT} FROM subscription_plans ${where} ORDER BY monthly_price ASC, id ASC`,
    params
  );
  return ok(res, { items: rows.map(normalizePlan) }, "Plans list");
}

/** Admin: create a new (non-custom) plan. */
export async function createPlan(req, res) {
  const body = validatePlanBody(req.body || {});
  const [result] = await pool.query(
    `INSERT INTO subscription_plans
       (name, monthly_price, daily_request_quota, description, features, billing_period, is_public, is_custom)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      body.name,
      body.monthly_price ?? "0.00",
      body.daily_request_quota ?? 0,
      body.description ?? null,
      body.features ?? JSON.stringify([]),
      body.billing_period ?? "monthly",
      body.is_public ?? 0,
    ]
  );
  const [[plan]] = await pool.query(
    `SELECT ${PLAN_SELECT} FROM subscription_plans WHERE id=?`,
    [result.insertId]
  );
  logAudit({
    ...getActorFromReq(req),
    action: "plans.create",
    entityType: "subscription_plan",
    entityId: plan.uuid,
    details: { name: plan.name, monthly_price: plan.monthly_price },
    req,
  });
  return created(res, { plan: normalizePlan(plan) }, "Plan created");
}

/** Admin: update a plan by uuid. */
export async function updatePlan(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Plan UUID");
  const body = validatePlanBody(req.body || {}, { partial: true });

  const [[existing]] = await pool.query(
    `SELECT uuid, is_custom FROM subscription_plans WHERE uuid=?`,
    [uuid]
  );
  if (!existing) throw new ApiError(404, "Plan not found");
  if (existing.is_custom === 1) {
    throw new ApiError(400, "Custom-assigned plans cannot be edited by admin");
  }

  const sets = [];
  const params = [];
  for (const key of [
    "name",
    "monthly_price",
    "daily_request_quota",
    "description",
    "features",
    "billing_period",
    "is_public",
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      sets.push(`\`${key}\`=?`);
      params.push(body[key]);
    }
  }
  if (!sets.length) throw new ApiError(400, "No fields to update");

  await pool.query(`UPDATE subscription_plans SET ${sets.join(", ")} WHERE uuid=?`, [
    ...params,
    uuid,
  ]);
  const [[plan]] = await pool.query(`SELECT ${PLAN_SELECT} FROM subscription_plans WHERE uuid=?`, [uuid]);
  logAudit({
    ...getActorFromReq(req),
    action: "plans.update",
    entityType: "subscription_plan",
    entityId: uuid,
    details: { name: plan.name, monthly_price: plan.monthly_price, is_public: plan.is_public },
    req,
  });
  return ok(res, { plan: normalizePlan(plan) }, "Plan updated");
}

/** Admin: toggle a plan's public visibility (show on marketing). */
export async function togglePlanPublic(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Plan UUID");
  const isPublic = Number(req.body?.is_public ?? req.body?.public ?? 0) ? 1 : 0;

  const [[existing]] = await pool.query(
    `SELECT uuid, is_custom FROM subscription_plans WHERE uuid=?`,
    [uuid]
  );
  if (!existing) throw new ApiError(404, "Plan not found");
  if (existing.is_custom === 1) {
    throw new ApiError(400, "Custom-assigned plans cannot be made public");
  }

  await pool.query(`UPDATE subscription_plans SET is_public=? WHERE uuid=?`, [isPublic, uuid]);
  const [[plan]] = await pool.query(`SELECT ${PLAN_SELECT} FROM subscription_plans WHERE uuid=?`, [uuid]);
  logAudit({
    ...getActorFromReq(req),
    action: isPublic ? "plans.publish" : "plans.unpublish",
    entityType: "subscription_plan",
    entityId: uuid,
    details: { name: plan.name },
    req,
  });
  return ok(res, { plan: normalizePlan(plan) }, isPublic ? "Plan is now public" : "Plan is now hidden");
}

/** Admin: delete a plan. Refused if it's assigned to any organization. */
export async function deletePlan(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Plan UUID");

  const [[existing]] = await pool.query(
    `SELECT uuid, name, is_custom FROM subscription_plans WHERE uuid=?`,
    [uuid]
  );
  if (!existing) throw new ApiError(404, "Plan not found");
  if (existing.is_custom === 1) {
    throw new ApiError(400, "Custom-assigned plans cannot be deleted");
  }

  const [[ref]] = await pool.query(
    `SELECT COUNT(*) AS c FROM organizations WHERE subscription_plan_id =
       (SELECT id FROM subscription_plans WHERE uuid=?)`,
    [uuid]
  );
  if (Number(ref?.c ?? 0) > 0) {
    throw new ApiError(409, "Cannot delete plan: it is assigned to one or more organizations");
  }

  await pool.query(`DELETE FROM subscription_plans WHERE uuid=?`, [uuid]);
  logAudit({
    ...getActorFromReq(req),
    action: "plans.delete",
    entityType: "subscription_plan",
    entityId: uuid,
    details: { name: existing.name },
    req,
  });
  return ok(res, { uuid }, "Plan deleted");
}
