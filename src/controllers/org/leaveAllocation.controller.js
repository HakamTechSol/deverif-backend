import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { employeeScopeCondition, assertEmployeeInDataScope } from "../../utils/dataScopes.js";
import { ok } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { logAudit, getActorFromReq } from "../../utils/auditLog.js";
import { isoDate } from "../../utils/leaveBalance.js";
import { getLeaveLedgerBalance, recordLeaveBalanceTransaction } from "../../utils/leaveLedger.js";
import * as payrollService from "../../services/payroll.service.js";

const DEFAULT_UNPAID_LEAVE_TYPE = "Unpaid Leave (Default)";
const isDefaultUnpaidLeaveType = (name) =>
  String(name).trim().toLowerCase() === DEFAULT_UNPAID_LEAVE_TYPE.toLowerCase();

/** Validate a year integer against a sane range. */
function parseYear(value) {
  const y = parseInt(value, 10);
  if (isNaN(y) || y < 2000 || y > 2100) {
    throw new ApiError(400, "A valid year is required");
  }
  return y;
}

/**
 * GET /org/leave-allocations?year=
 * Returns a per-employee x per-leave-type allocation grid for the given year
 * for the org-admin's own organization.
 */
export async function listLeaveAllocations(req, res) {
  const orgId = req.scopeOrgId;
  const year = req.query.year ? parseYear(req.query.year) : new Date().getFullYear();

  const [types] = await pool.query(
    "SELECT id, name FROM leave_types WHERE organization_id=? AND name<>? ORDER BY name",
    [orgId, DEFAULT_UNPAID_LEAVE_TYPE]
  );
  const [designations] = await pool.query(
    "SELECT uuid, name FROM designations WHERE organization_id=? ORDER BY name",
    [orgId]
  );

  // `e.status <> 'removed'` was here and was ALWAYS TRUE: 'removed' has never been
  // a member of the status enum, so MySQL coerced the literal to index 0 and the
  // predicate matched every row. The screen was therefore listing ex-employees —
  // and every resigned/terminated row — alongside current staff, with no way to
  // tell them apart. Now that status distinguishes them, filter properly.
  //
  // Deactivated ('inactive') employees ARE included: they remain on the roster
  // and are still accruing/entitling leave, so excluding them would let an
  // admin assign nothing to a colleague they merely switched off.
  const scopeFilter = employeeScopeCondition(req, "leave_management", "e");
  const employeeScopeSql = scopeFilter ? ` AND ${scopeFilter.sql}` : "";
  const [employees] = await pool.query(
    `SELECT e.uuid AS employee_uuid, e.full_name, e.email, dg.uuid AS designation_uuid,
            dg.name AS designation, dp.name AS department, e.status
     FROM employees e
     LEFT JOIN designations dg ON dg.id = e.designation_id
     LEFT JOIN departments dp ON dp.id = e.department_id
     WHERE e.organization_id = ? AND e.status IN ('active','current_employee')${employeeScopeSql}
     ORDER BY e.full_name`,
    [orgId, ...(scopeFilter?.params ?? [])]
  );

  const [rows] = await pool.query(
    `SELECT employee_uuid, leave_type_id, allocated_days, used_days, remaining_days FROM employee_leave_allocations WHERE year=? AND employee_uuid IN (SELECT e.uuid FROM employees e WHERE e.organization_id=?${employeeScopeSql})`,
    [year, orgId, ...(scopeFilter?.params ?? [])]
  );

  const map = new Map();
  for (const r of rows) {
    const key = r.employee_uuid;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(r.leave_type_id, {
      allocated_days: r.allocated_days,
      used_days: r.used_days,
      remaining_days: r.remaining_days,
    });
  }

  const employeeRows = employees.map((e) => ({
    employee_uuid: e.employee_uuid,
    full_name: e.full_name,
    email: e.email,
    designation_uuid: e.designation_uuid,
    designation: e.designation,
    department: e.department,
    status: e.status,
    allocations: types.map((t) => {
      const a = map.get(e.employee_uuid)?.get(t.id);
      return {
        leave_type_id: t.id,
        allocated_days: a ? a.allocated_days : 0,
        used_days: a ? a.used_days : 0,
        remaining_days: a ? a.remaining_days : 0,
      };
    }),
  }));

  return ok(res, { year, leaveTypes: types, designations, employees: employeeRows }, "Leave allocations");
}

/**
 * PUT /org/leave-allocations/designation
 * Saves a type/year policy and applies it to every eligible employee currently
 * assigned to the designation. New employees inherit this policy on hire.
 */
export async function setDesignationLeaveAllocation(req, res) {
  const orgId = req.scopeOrgId;
  const { designation_uuid, leave_type_id, year, allocated_days } = req.body || {};
  assertUuid(designation_uuid, "Designation UUID");
  const typeId = parseInt(leave_type_id, 10);
  const yr = parseYear(year);
  if (isNaN(typeId)) throw new ApiError(400, "leave_type_id is required");
  const alloc = parseInt(allocated_days, 10);
  if (isNaN(alloc) || alloc < 0) {
    throw new ApiError(400, "allocated_days must be a non-negative integer");
  }

  const [[designation]] = await pool.query(
    "SELECT id, name FROM designations WHERE uuid=? AND organization_id=?",
    [designation_uuid, orgId]
  );
  if (!designation) throw new ApiError(404, "Designation not found");
  const [[lt]] = await pool.query(
    "SELECT id, name FROM leave_types WHERE id=? AND organization_id=?",
    [typeId, orgId]
  );
  if (!lt) throw new ApiError(404, "Leave type not found");
  if (isDefaultUnpaidLeaveType(lt.name)) {
    throw new ApiError(400, `"${DEFAULT_UNPAID_LEAVE_TYPE}" does not use leave allocations.`);
  }

  const conn = await pool.getConnection();
  let employeeCount = 0;
  try {
    await conn.beginTransaction();
    const designationScope = employeeScopeCondition(req, "leave_management", "e");
    const designationScopeSql = designationScope ? ` AND ${designationScope.sql}` : "";
    const designationParams = [orgId, designation.id, ...(designationScope?.params ?? [])];
    const [[count]] = await conn.query(
      `SELECT COUNT(*) AS employee_count FROM employees e
       WHERE e.organization_id=? AND e.designation_id=? AND e.status IN ('active','current_employee')${designationScopeSql}`,
      designationParams
    );
    employeeCount = Number(count.employee_count);

    await conn.query(
      `INSERT INTO designation_leave_policies
         (uuid, organization_id, designation_id, leave_type_id, year, allocated_days)
       VALUES (UUID(), ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE allocated_days=VALUES(allocated_days)`,
      [orgId, designation.id, typeId, yr, alloc]
    );

    if (employeeCount) {
      const [employees] = await conn.query(
        `SELECT e.uuid FROM employees e
         WHERE e.organization_id=? AND e.designation_id=? AND e.status IN ('active','current_employee')${designationScopeSql}
         FOR UPDATE`,
        designationParams,
      );
      for (const employee of employees) {
        const [[current]] = await conn.query(
          `SELECT * FROM employee_leave_allocations
           WHERE employee_uuid=? AND leave_type_id=? AND year=? FOR UPDATE`,
          [employee.uuid, typeId, yr],
        );
        if (!current) {
          const [inserted] = await conn.query(
            `INSERT INTO employee_leave_allocations
               (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days)
             VALUES (UUID(), ?, ?, ?, ?, 0, ?)`,
            [employee.uuid, typeId, yr, alloc, alloc],
          );
          await recordLeaveBalanceTransaction(conn, {
            employeeUuid: employee.uuid,
            leaveTypeId: typeId,
            allocationId: inserted.insertId,
            transactionType: "allocation",
            creditedDays: alloc,
            previousBalance: 0,
            updatedBalance: alloc,
            performedBy: req.user?.uuid || req.admin?.uuid || null,
            reason: `Initial leave allocation for ${yr} by designation policy.`,
          });
          continue;
        }
        const previousBalance = await getLeaveLedgerBalance(conn, current.id, current.remaining_days);
        const updatedBalance = Math.max(0, alloc - Number(current.used_days));
        await conn.query(
          "UPDATE employee_leave_allocations SET allocated_days=?, remaining_days=? WHERE id=?",
          [alloc, updatedBalance, current.id],
        );
        const difference = updatedBalance - previousBalance;
        if (difference !== 0) {
          await recordLeaveBalanceTransaction(conn, {
            employeeUuid: employee.uuid,
            leaveTypeId: typeId,
            allocationId: current.id,
            transactionType: "admin_adjustment",
            creditedDays: difference > 0 ? difference : 0,
            debitedDays: difference < 0 ? -difference : 0,
            previousBalance,
            updatedBalance,
            performedBy: req.user?.uuid || req.admin?.uuid || null,
            reason: `Designation policy allocation changed to ${alloc} days for ${yr}.`,
          });
        }
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  logAudit({
    ...getActorFromReq(req),
    action: "leave_allocation.set_designation",
    entityType: "designation_leave_allocation",
    entityId: designation_uuid,
    details: { designation_uuid, designation: designation.name, leave_type_id: typeId, year: yr, allocated_days: alloc, employee_count: employeeCount },
    req,
  });

  return ok(res, { designation_uuid, designation: designation.name, leave_type_name: lt.name, year: yr, allocated_days: alloc, employee_count: employeeCount }, "Designation leave policy saved");
}

/**
 * PUT /org/leave-allocations
 * body: { employee_uuid, leave_type_id, year, allocated_days }
 * Upserts an individual employee's allocation for a type/year. `used_days`
 * history is preserved; `remaining_days` is kept consistent with the new cap.
 */
export async function setLeaveAllocation(req, res) {
  const orgId = req.scopeOrgId;
  const { employee_uuid, leave_type_id, year, allocated_days } = req.body || {};
  assertUuid(employee_uuid, "Employee UUID");
  await assertEmployeeInDataScope(req, "leave_management", employee_uuid);
  const typeId = parseInt(leave_type_id, 10);
  const yr = parseYear(year);
  if (isNaN(typeId)) throw new ApiError(400, "leave_type_id is required");
  const alloc = parseInt(allocated_days, 10);
  if (isNaN(alloc) || alloc < 0) {
    throw new ApiError(400, "allocated_days must be a non-negative integer");
  }

  const [[emp]] = await pool.query(
    "SELECT uuid FROM employees WHERE uuid=? AND organization_id=?",
    [employee_uuid, orgId]
  );
  if (!emp) throw new ApiError(404, "Employee not found");

  const [[lt]] = await pool.query(
    "SELECT id, name FROM leave_types WHERE id=? AND organization_id=?",
    [typeId, orgId]
  );
  if (!lt) throw new ApiError(404, "Leave type not found");
  if (isDefaultUnpaidLeaveType(lt.name)) {
    throw new ApiError(400, `"${DEFAULT_UNPAID_LEAVE_TYPE}" does not use leave allocations.`);
  }

  const conn = await pool.getConnection();
  let row;
  try {
    await conn.beginTransaction();
    const [[existing]] = await conn.query(
      `SELECT * FROM employee_leave_allocations
       WHERE employee_uuid=? AND leave_type_id=? AND year=? FOR UPDATE`,
      [employee_uuid, typeId, yr],
    );
    if (existing) {
      const used = Number(existing.used_days);
      const previousBalance = await getLeaveLedgerBalance(conn, existing.id, existing.remaining_days);
      const remaining = Math.max(0, alloc - used);
      await conn.query(
        "UPDATE employee_leave_allocations SET allocated_days=?, remaining_days=? WHERE id=?",
        [alloc, remaining, existing.id],
      );
      row = { id: existing.id, allocated_days: alloc, used_days: used, remaining_days: remaining };
      const difference = remaining - previousBalance;
      if (difference !== 0) {
        await recordLeaveBalanceTransaction(conn, {
          employeeUuid: employee_uuid,
          leaveTypeId: typeId,
          allocationId: existing.id,
          transactionType: "admin_adjustment",
          creditedDays: difference > 0 ? difference : 0,
          debitedDays: difference < 0 ? -difference : 0,
          previousBalance,
          updatedBalance: remaining,
          performedBy: req.user?.uuid || req.admin?.uuid || null,
          reason: `Admin changed allocation to ${alloc} days for ${yr}.`,
        });
      }
    } else {
      const [ins] = await conn.query(
        `INSERT INTO employee_leave_allocations
           (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days)
         VALUES (UUID(), ?, ?, ?, ?, 0, ?)`,
        [employee_uuid, typeId, yr, alloc, alloc],
      );
      row = { id: ins.insertId, allocated_days: alloc, used_days: 0, remaining_days: alloc };
      await recordLeaveBalanceTransaction(conn, {
        employeeUuid: employee_uuid,
        leaveTypeId: typeId,
        allocationId: ins.insertId,
        transactionType: "allocation",
        creditedDays: alloc,
        previousBalance: 0,
        updatedBalance: alloc,
        performedBy: req.user?.uuid || req.admin?.uuid || null,
        reason: `Initial admin allocation for ${yr}.`,
      });
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  logAudit({
    ...getActorFromReq(req),
    action: "leave_allocation.set",
    entityType: "employee_leave_allocation",
    entityId: String(row.id),
    details: { employee_uuid, leave_type_id: typeId, year: yr, allocated_days: alloc },
    req,
  });

  return ok(res, { allocation: row, leave_type_name: lt.name }, "Allocation saved");
}

/**
 * GET /org/employees/:uuid/leave-allocations
 * Returns an individual employee's allocation history across all years
 * (permanent history; nothing is reset). Org-admin only.
 */
export async function getEmployeeLeaveHistory(req, res) {
  const orgId = req.scopeOrgId;
  const { uuid } = req.params;
  assertUuid(uuid, "Employee UUID");
  await assertEmployeeInDataScope(req, "leave_management", uuid);

  const [[emp]] = await pool.query(
    "SELECT uuid, full_name, email FROM employees WHERE uuid=? AND organization_id=?",
    [uuid, orgId]
  );
  if (!emp) throw new ApiError(404, "Employee not found");

  const [balances] = await pool.query(
    `SELECT ela.year, ela.allocated_days, ela.used_days, ela.remaining_days,
            lt.id AS leave_type_id, lt.name AS leave_type_name
     FROM employee_leave_allocations ela
     JOIN leave_types lt ON lt.id = ela.leave_type_id
     WHERE ela.employee_uuid=?
     ORDER BY ela.year DESC, lt.name`,
    [uuid]
  );

  const [requests] = await pool.query(
    `SELECT lr.uuid, lr.leave_type_id,
            CASE WHEN lt.name = '${DEFAULT_UNPAID_LEAVE_TYPE}' THEN 'Unpaid Leave' ELSE lt.name END AS leave_type_name,
            lr.start_date, lr.end_date, lr.status, lr.day_portion, lr.approved_days,
            lr.requested_treatment, lr.approved_treatment
     FROM leave_requests lr
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.employee_uuid=?
     ORDER BY lr.start_date DESC, lr.created_at DESC`,
    [uuid]
  );
  const leaveHistory = await Promise.all(requests.map(async (r) => {
    const startDate = isoDate(r.start_date);
    const endDate = isoDate(r.end_date);
    const workingDates = await payrollService.getWorkingDatesBetween({
      orgId,
      startDate,
      endDate,
    });
    return {
      ...r,
      start_date: startDate,
      end_date: endDate,
      days: r.approved_days ?? (r.day_portion === "full" ? workingDates.length : 0.5),
    };
  }));
  const [ledger] = await pool.query(
    `SELECT id, leave_type_id, transaction_type, credited_days, debited_days,
            previous_balance, updated_balance, related_leave_request_uuid,
            transaction_at, performed_by, reason
     FROM leave_balance_ledger
     WHERE employee_uuid=?
     ORDER BY transaction_at DESC, id DESC`,
    [uuid],
  );

  return ok(
    res,
    {
      employee_uuid: uuid,
      employee_name: emp.full_name,
      employee_email: emp.email,
      balances,
      leave_history: leaveHistory,
      balance_ledger: ledger,
    },
    "Employee leave history"
  );
}
