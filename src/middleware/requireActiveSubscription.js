import ApiError from "../utils/ApiError.js";
import { pool } from "../config/db.js";

/**
 * Gates WRITE operations for the org modules (employees, org admins, leave,
 * attendance, salary components, payroll) behind an ACTIVE subscription.
 *
 * When the subscription lapses the modules become read-only: GET (viewing
 * data) still works, but create/update/delete return 403.
 *
 * MUST be placed after requireRole(...) so that req.scopeOrgId is set.
 */
export default async function requireActiveSubscription(req, res, next) {
  try {
    if (req.method === "GET") return next();
    if (req.method === "OPTIONS") return next();

    const orgId = req.scopeOrgId ?? req.user?.organization;
    if (!orgId) throw new ApiError(403, "User has no organization");

    const [[org]] = await pool.query(
      "SELECT subscription_status FROM organizations WHERE id=?",
      [orgId]
    );
    if (!org || org.subscription_status !== "active") {
      throw new ApiError(
        403,
        "Your organization does not have an active subscription. Please subscribe to use these modules."
      );
    }
    next();
  } catch (e) {
    next(e);
  }
}
