import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";
import { normalizePlanFeatures } from "../utils/planFeatures.js";
import { parseModuleFlags } from "../utils/moduleFlags.js";

/**
 * Public, unauthenticated: return the plans to display on the marketing/landing
 * site (pricing section). Only non-custom plans explicitly marked is_public=1.
 */
export async function listPublicPlans(req, res) {
  const [rows] = await pool.query(
    `SELECT uuid, name, monthly_price, daily_request_quota, description, features,
            billing_period, is_recommended, is_free, module_flags
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
    features: normalizePlanFeatures(r.features),
    billing_period: r.billing_period,
    is_recommended: Number(r.is_recommended ?? 0),
    is_free: Number(r.is_free ?? 0),
    // module_flags is the AUTHORITATIVE include/exclude data -- it is what
    // requireModuleFeature.js actually enforces at request time. Shipping it
    // lets the pricing UI mark a genuinely unavailable module as excluded,
    // instead of guessing from the `highlight` styling flag on a free-text
    // feature list.
    module_flags: parseModuleFlags(r.module_flags),
  }));
  return ok(res, { items: plans }, "Public plans");
}
