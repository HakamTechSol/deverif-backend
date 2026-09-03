import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";

/**
 * Public, unauthenticated: return the plans to display on the marketing/landing
 * site (pricing section). Only non-custom plans explicitly marked is_public=1.
 */
export async function listPublicPlans(req, res) {
  const [rows] = await pool.query(
    `SELECT uuid, name, monthly_price, daily_request_quota, description, features,
            billing_period
     FROM subscription_plans
     WHERE is_public = 1 AND is_custom = 0
     ORDER BY monthly_price ASC, id ASC`
  );
  const plans = rows.map((r) => ({
    uuid: r.uuid,
    name: r.name,
    monthly_price: Number(r.monthly_price),
    daily_request_quota: Number(r.daily_request_quota),
    description: r.description,
    features: (() => {
      if (!r.features) return [];
      try {
        const parsed = JSON.parse(r.features);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })(),
    billing_period: r.billing_period,
  }));
  return ok(res, { items: plans }, "Public plans");
}
