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

  return result.affectedRows;
}
