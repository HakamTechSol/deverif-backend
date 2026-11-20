/**
 * Give an employee the stored designation policy for the current and future
 * calendar years. Existing allocations are preserved so used leave and any
 * employee-specific adjustment are not overwritten.
 */
export async function applyDesignationLeavePolicies(conn, organizationId, employeeUuid, designationId) {
  if (!designationId) return 0;

  const currentYear = new Date().getFullYear();
  const [result] = await conn.query(
    `INSERT INTO employee_leave_allocations
       (uuid, employee_uuid, leave_type_id, year, allocated_days, used_days, remaining_days)
     SELECT UUID(), ?, p.leave_type_id, p.year, p.allocated_days, 0, p.allocated_days
     FROM designation_leave_policies p
     WHERE p.organization_id=? AND p.designation_id=? AND p.year>=?
     ON DUPLICATE KEY UPDATE employee_uuid=VALUES(employee_uuid)`,
    [employeeUuid, organizationId, designationId, currentYear]
  );

  await conn.query(
    `INSERT INTO leave_balance_ledger
       (employee_uuid, leave_type_id, allocation_id, transaction_type,
        credited_days, debited_days, previous_balance, updated_balance, reason)
     SELECT ela.employee_uuid, ela.leave_type_id, ela.id, 'allocation',
            ela.remaining_days, 0, 0, ela.remaining_days,
            CONCAT('Initial designation policy allocation for ', ela.year, '.')
     FROM employee_leave_allocations ela
     WHERE ela.employee_uuid=? AND ela.year>=?
       AND NOT EXISTS (
         SELECT 1 FROM leave_balance_ledger ledger WHERE ledger.allocation_id=ela.id
       )`,
    [employeeUuid, currentYear],
  );

  return result.affectedRows;
}
