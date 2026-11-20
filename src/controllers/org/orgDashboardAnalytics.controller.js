import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { getOrgQuotaStatus } from "../../utils/requestQuota.js";

/**
 * GET /org/dashboard/analytics
 * Returns HR + quota data scoped to the requesting org.
 */
export async function orgDashboardAnalytics(req, res) {
  const orgId = req.scopeOrgId;
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  const today = new Date().toISOString().slice(0, 10);
  const fromDate = validDate(req.query.from) ? req.query.from : today.slice(0, 8) + "01";
  const toDate = validDate(req.query.to) ? req.query.to : today;
  if (fromDate > toDate || toDate > today) return res.status(400).json({ success: false, message: "Invalid dashboard date range" });

  // 1. Active employee count.
  // 'active' (deactivated) counts as staff: they are still on the roster and
  // still occupying a seat, they simply cannot log in. The old query was
  // `status='active' AND record_type='roster'`, which after the merge collapses
  // to the status test alone.
  const [[empCount]] = await pool.query(
    `SELECT COUNT(*) AS total FROM employees
      WHERE organization_id=? AND status IN ('active','current_employee')`,
    [orgId]
  );

  // 2. Pending leave requests count
  const [[pendingLeaves]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM leave_requests lr
     JOIN employees e ON e.uuid = lr.employee_uuid
     WHERE e.organization_id=? AND lr.status='pending' AND DATE(lr.created_at) BETWEEN ? AND ?`,
    [orgId, fromDate, toDate]
  );

  // 3. Today's attendance (present vs total active employees)
  const [[todayPresent]] = await pool.query(
    `SELECT COUNT(DISTINCT ar.employee_uuid) AS present
     FROM attendance_records ar
     JOIN employees e ON e.uuid = ar.employee_uuid
     WHERE e.organization_id=? AND ar.date BETWEEN ? AND ?`,
    [orgId, fromDate, toDate]
  );
  const todayAttendance = {
    present: todayPresent.present,
    total: empCount.total,
  };

  // 4. This month's payroll total
  const [[payrollTotal]] = await pool.query(
    `SELECT COALESCE(SUM(net_salary), 0) AS total
     FROM salary_records
     WHERE organization_id=? AND STR_TO_DATE(CONCAT(year, '-', LPAD(month, 2, '0'), '-01'), '%Y-%m-%d') BETWEEN DATE_FORMAT(?, '%Y-%m-01') AND LAST_DAY(?)`,
    [orgId, fromDate, toDate]
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
     WHERE e.organization_id=? AND e.status IN ('active','current_employee')
     GROUP BY dp.name
     ORDER BY count DESC`,
    [orgId]
  );

  // 7. Today's attendance breakdown (present / absent / late)
  //    present = checked_in or checked_out today; absent = current employees with no record today
  //    late = checked_in after 09:30 (simple heuristic)
  //
  //    Filters on current-employee status so an archived ex-employee's leftover
  //    attendance rows cannot be counted as present. They would otherwise
  //    inflate `present` against a headcount that no longer includes them and
  //    drive the absent count to zero.
  const [todayRecords] = await pool.query(
    `SELECT ar.employee_uuid,
            ar.check_in_at,
            ar.check_out_at,
            ar.status
     FROM attendance_records ar
     JOIN employees e ON e.uuid = ar.employee_uuid
     WHERE e.organization_id=? AND ar.date BETWEEN ? AND ?
       AND e.status IN ('active','current_employee')`,
    [orgId, fromDate, toDate]
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
       AND STR_TO_DATE(CONCAT(year, '-', LPAD(month, 2, '0'), '-01'), '%Y-%m-%d') BETWEEN DATE_FORMAT(?, '%Y-%m-01') AND LAST_DAY(?)
     GROUP BY month
     ORDER BY month ASC`,
    [orgId, fromDate, toDate]
  );

  // 9. Leave utilization by type (current year approved days for all configured leave types)
  const [leaveUtil] = await pool.query(
    `SELECT lt.name AS leave_type,
            COALESCE(SUM(
              CASE
                WHEN lr.status = 'approved' AND lr.start_date <= ? AND lr.end_date >= ? THEN
                  DATEDIFF(LEAST(lr.end_date, ?), GREATEST(lr.start_date, ?)) + 1
                ELSE 0
              END
            ), 0) AS days_used
     FROM leave_types lt
     LEFT JOIN leave_requests lr ON lt.id = lr.leave_type_id
     LEFT JOIN employees e ON e.uuid = lr.employee_uuid AND e.organization_id = lt.organization_id
     WHERE lt.organization_id = ?
     GROUP BY lt.id, lt.name
     ORDER BY days_used DESC, lt.name ASC`,
    [toDate, fromDate, toDate, fromDate, orgId]
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
    date_range: { from: fromDate, to: toDate },
  }, "Org dashboard analytics");
}
