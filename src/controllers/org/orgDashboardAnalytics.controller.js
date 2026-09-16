import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { getOrgQuotaStatus } from "../../utils/requestQuota.js";

/**
 * GET /org/dashboard/analytics
 * Returns HR + quota data scoped to the requesting org.
 */
export async function orgDashboardAnalytics(req, res) {
  const orgId = req.scopeOrgId;

  // 1. Active employee count
  const [[empCount]] = await pool.query(
    `SELECT COUNT(*) AS total FROM employees WHERE organization_id=? AND status='active'`,
    [orgId]
  );

  // 2. Pending leave requests count
  const [[pendingLeaves]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     WHERE e.organization_id=? AND lr.status='pending'`,
    [orgId]
  );

  // 3. Today's attendance (present vs total active employees)
  const [[todayPresent]] = await pool.query(
    `SELECT COUNT(DISTINCT ar.employee_uuid) AS present
     FROM attendance_records ar
     JOIN employees e ON e.uuid = ar.employee_uuid
     WHERE e.organization_id=? AND ar.date = CURDATE()`,
    [orgId]
  );
  const todayAttendance = {
    present: todayPresent.present,
    total: empCount.total,
  };

  // 4. This month's payroll total
  const [[payrollTotal]] = await pool.query(
    `SELECT COALESCE(SUM(net_salary), 0) AS total
     FROM salary_records
     WHERE organization_id=? AND month=MONTH(CURDATE()) AND year=YEAR(CURDATE())`,
    [orgId]
  );

  // 5. Quota status
  let quotaStatus = null;
  try {
    quotaStatus = await getOrgQuotaStatus(orgId);
  } catch {
    // ignore — not all orgs have a quota row
  }

  // 6. Headcount by department
  const [deptHeadcount] = await pool.query(
    `SELECT COALESCE(dp.name, 'Unassigned') AS department, COUNT(*) AS count
     FROM employees e
     LEFT JOIN departments dp ON dp.id = e.department_id
     WHERE e.organization_id=? AND e.status='active'
     GROUP BY dp.name
     ORDER BY count DESC`,
    [orgId]
  );

  // 7. Today's attendance breakdown (present / absent / late)
  //    present = checked_in or checked_out today; absent = active employees with no record today
  //    late = checked_in after 09:30 (simple heuristic)
  const [todayRecords] = await pool.query(
    `SELECT ar.employee_uuid,
            ar.check_in_at,
            ar.check_out_at,
            ar.status
     FROM attendance_records ar
     JOIN employees e ON e.uuid = ar.employee_uuid
     WHERE e.organization_id=? AND ar.date = CURDATE()`,
    [orgId]
  );

  const presentUuids = new Set(todayRecords.map((r) => r.employee_uuid));
  const lateCount = todayRecords.filter((r) => {
    if (!r.check_in_at) return false;
    const h = new Date(r.check_in_at).getHours();
    const m = new Date(r.check_in_at).getMinutes();
    return h > 9 || (h === 9 && m > 30);
  }).length;
  const presentOnTime = Math.max(0, presentUuids.size - lateCount);
  const absentCount = Math.max(0, empCount.total - presentUuids.size);

  const attendanceBreakdown = {
    present: presentOnTime,
    late: lateCount,
    absent: absentCount,
    total: empCount.total,
  };

  // 8. Monthly payroll trend (last 12 months)
  const [payrollTrend] = await pool.query(
    `SELECT DATE_FORMAT(STR_TO_DATE(CONCAT(year, '-', month, '-01'), '%Y-%m-%d'), '%Y-%m') AS month,
            COALESCE(SUM(net_salary), 0) AS total
     FROM salary_records
     WHERE organization_id=?
       AND STR_TO_DATE(CONCAT(year, '-', month, '-01'), '%Y-%m-%d') >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
     GROUP BY month
     ORDER BY month ASC`,
    [orgId]
  );

  // 9. Leave utilization by type (current year approved days)
  const [leaveUtil] = await pool.query(
    `SELECT lt.name AS leave_type,
            COALESCE(SUM(
              DATEDIFF(
                LEAST(lr.end_date, LAST_DAY(CONCAT(YEAR(CURDATE()), '-', LPAD(MONTH(CURDATE()),2,'0'), '-01'))),
                GREATEST(lr.start_date, CONCAT(YEAR(CURDATE()), '-01-01'))
              ) + 1
            ), 0) AS days_used
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE e.organization_id=? AND lr.status='approved' AND YEAR(lr.start_date)=YEAR(CURDATE())
     GROUP BY lt.id, lt.name
     ORDER BY days_used DESC`,
    [orgId]
  );

  return ok(res, {
    active_employee_count: empCount.total,
    pending_leave_requests_count: pendingLeaves.total,
    today_attendance: todayAttendance,
    this_month_payroll_total: Number(payrollTotal.total),
    quota_status: quotaStatus,
    headcount_by_department: deptHeadcount,
    today_attendance_breakdown: attendanceBreakdown,
    monthly_payroll_trend: payrollTrend,
    leave_utilization: leaveUtil,
  }, "Org dashboard analytics");
}
