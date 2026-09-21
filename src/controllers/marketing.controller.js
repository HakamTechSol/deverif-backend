import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { normalizePlanFeatures } from "../utils/planFeatures.js";

/**
 * Public, unauthenticated: return the plans to display on the marketing/landing
 * site (pricing section). Only non-custom plans explicitly marked is_public=1.
 */
export async function listPublicPlans(req, res) {
  const [rows] = await pool.query(
    `SELECT uuid, name, monthly_price, daily_request_quota, description, features,
            billing_period, is_recommended
     FROM subscription_plans
     WHERE is_public = 1 AND is_custom = 0
     ORDER BY is_recommended DESC, monthly_price ASC, id ASC`
  );
  const plans = rows.map((r) => ({
    uuid: r.uuid,
    name: r.name,
    monthly_price: Number(r.monthly_price),
    daily_request_quota: Number(r.daily_request_quota),
    description: r.description,
    features: normalizePlanFeatures(r.features),
    billing_period: r.billing_period,
    is_recommended: Number(r.is_recommended ?? 0),
  }));
  return ok(res, { items: plans }, "Public plans");
}
