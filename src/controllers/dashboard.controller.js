import { pool } from "../config/db.js";
import { ok } from "../utils/response.js";

export async function userDashboardStats(req, res) {
  const [usersCountRows] = await pool.query(
    req.user.organization
      ? "SELECT COUNT(*) AS total FROM users WHERE organization = ?"
      : "SELECT COUNT(*) AS total FROM users",
    req.user.organization ? [req.user.organization] : []
  );

  const [organizationsCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM organizations"
  );
  const [verifiedOrgsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM organizations WHERE verified='yes'"
  );

  const [verificationRequestsCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ?",
    [req.user.id]
  );
  const [verifiedReqsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ? AND status='verified'",
    [req.user.id]
  );
  const [unverifiedReqsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ? AND status='unverified'",
    [req.user.id]
  );
  const [underReviewReqsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ? AND status='under_review'",
    [req.user.id]
  );

  const [adminRequestsCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ? AND issuing_organization_id IS NULL",
    [req.user.id]
  );

  const totalReqs = verificationRequestsCountRows[0].total || 0;
  const totalOrgs = organizationsCountRows[0].total || 0;

  return ok(res, {
    total_users: usersCountRows[0].total,
    total_organizations: totalOrgs,
    total_verification_requests: totalReqs,
    total_admin_requests: adminRequestsCountRows[0].total,
    verified_organizations: verifiedOrgsRows[0].total,
    verified_requests: verifiedReqsRows[0].total,
    unverified_requests: unverifiedReqsRows[0].total,
    under_review_requests: underReviewReqsRows[0].total,
    organizations_progress: totalOrgs > 0 ? Math.round((verifiedOrgsRows[0].total / totalOrgs) * 100) : 0,
    requests_progress: totalReqs > 0 ? Math.round((verifiedReqsRows[0].total / totalReqs) * 100) : 0,
    unmatched_progress: totalReqs > 0 ? Math.round(((totalReqs - adminRequestsCountRows[0].total) / totalReqs) * 100) : 100,
  }, "User dashboard stats");
}

export async function adminDashboardStats(req, res) {
  const [usersCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM users"
  );
  const [activeUsersRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM users WHERE status='active'"
  );

  const [organizationsCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM organizations"
  );
  const [verifiedOrgsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM organizations WHERE verified='yes'"
  );

  const [verificationRequestsCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests"
  );
  const [verifiedReqsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE status='verified'"
  );
  const [unverifiedReqsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE status='unverified'"
  );
  const [underReviewReqsRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE status='under_review'"
  );

  const [adminRequestsCountRows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE issuing_organization_id IS NULL"
  );

  const totalUsers = usersCountRows[0].total || 0;
  const totalOrgs = organizationsCountRows[0].total || 0;
  const totalReqs = verificationRequestsCountRows[0].total || 0;
  const unmatched = adminRequestsCountRows[0].total || 0;

  return ok(res, {
    total_users: totalUsers,
    total_organizations: totalOrgs,
    total_verification_requests: totalReqs,
    total_admin_requests: unmatched,
    active_users: activeUsersRows[0].total,
    verified_organizations: verifiedOrgsRows[0].total,
    verified_requests: verifiedReqsRows[0].total,
    unverified_requests: unverifiedReqsRows[0].total,
    under_review_requests: underReviewReqsRows[0].total,
    users_progress: totalUsers > 0 ? Math.round((activeUsersRows[0].total / totalUsers) * 100) : 0,
    organizations_progress: totalOrgs > 0 ? Math.round((verifiedOrgsRows[0].total / totalOrgs) * 100) : 0,
    requests_progress: totalReqs > 0 ? Math.round((verifiedReqsRows[0].total / totalReqs) * 100) : 0,
    unmatched_progress: totalReqs > 0 ? Math.round(((totalReqs - unmatched) / totalReqs) * 100) : 100,
    upcoming_expirations: await getUpcomingExpirations(),
  }, "Admin dashboard stats");
}

export async function dashboardStats(req, res) {
  if (req.admin) {
    return adminDashboardStats(req, res);
  }
  return userDashboardStats(req, res);
}

export async function userRequestsCount(req, res) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE user_id = ?",
    [req.user.id]
  );
  return ok(res, { total: rows[0].total }, "User requests count");
}

export async function organizationCount(req, res) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS total FROM organizations"
  );
  return ok(res, { total: rows[0].total }, "Organization count");
}

export async function adminVerificationCount(req, res) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests"
  );
  return ok(res, { total: rows[0].total }, "Admin verification count");
}

export async function adminRequestsCount(req, res) {
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS total FROM verification_requests WHERE issuing_organization_id IS NULL"
  );
  return ok(res, { total: rows[0].total }, "Admin requests count");
}

async function getUpcomingExpirations() {
  try {
    const [rows] = await pool.query(
      `SELECT uuid, name, subscription_expiry
       FROM organizations
       WHERE subscription_status='active' AND subscription_expiry IS NOT NULL
       AND subscription_expiry > NOW()
       AND subscription_expiry <= DATE_ADD(NOW(), INTERVAL 7 DAY)
       ORDER BY subscription_expiry ASC
       LIMIT 10`
    );
    return rows.map((r) => ({
      uuid: r.uuid,
      name: r.name,
      subscription_expiry: r.subscription_expiry,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Admin analytics — aggregated data for charts
// ---------------------------------------------------------------------------

export async function adminDashboardAnalytics(_req, res) {
  // 1. Requests per month (last 12 months)
  const [requestsPerMonth] = await pool.query(`
    SELECT DATE_FORMAT(submitted_at, '%Y-%m') AS month, COUNT(*) AS count
    FROM verification_requests
    WHERE submitted_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    GROUP BY DATE_FORMAT(submitted_at, '%Y-%m')
    ORDER BY month ASC
  `);

  // 2. Request status breakdown (all-time)
  const [statusBreakdown] = await pool.query(`
    SELECT status, COUNT(*) AS count
    FROM verification_requests
    GROUP BY status
  `);

  // 3. Organizations registered per month (last 12 months)
  const [orgsPerMonth] = await pool.query(`
    SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) AS count
    FROM organizations
    WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m')
    ORDER BY month ASC
  `);

  // 4. Top 10 organizations by verification requests (last 90 days)
  const [topOrgs] = await pool.query(`
    SELECT o.name AS org_name, COUNT(*) AS request_count
    FROM verification_requests vr
    JOIN organizations o ON o.id = vr.issuing_organization_id
    WHERE vr.submitted_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
      AND vr.issuing_organization_id IS NOT NULL
    GROUP BY o.id, o.name
    ORDER BY request_count DESC
    LIMIT 10
  `);

  return ok(res, {
    requests_per_month: requestsPerMonth,
    request_status_breakdown: statusBreakdown,
    orgs_registered_per_month: orgsPerMonth,
    top_organizations_by_requests: topOrgs,
  }, "Admin dashboard analytics");
}
