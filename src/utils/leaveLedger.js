import ApiError from "./ApiError.js";

export async function getLeaveLedgerBalance(conn, allocationId, currentAllocationBalance) {
  const [[entry]] = await conn.query(
    `SELECT updated_balance
     FROM leave_balance_ledger
     WHERE allocation_id=?
     ORDER BY id DESC
     LIMIT 1
     FOR UPDATE`,
    [allocationId],
  );
  if (!entry) return Number(currentAllocationBalance);
  const ledgerBalance = Number(entry.updated_balance);
  if (Math.abs(ledgerBalance - Number(currentAllocationBalance)) > 0.001) {
    throw new ApiError(409, "Leave balance ledger and allocation are inconsistent; reconcile the ledger before changing this balance.");
  }
  return ledgerBalance;
}

export async function recordLeaveBalanceTransaction(conn, {
  employeeUuid,
  leaveTypeId,
  allocationId = null,
  transactionType,
  creditedDays = 0,
  debitedDays = 0,
  previousBalance,
  updatedBalance,
  leaveRequestUuid = null,
  performedBy = null,
  reason,
}) {
  await conn.query(
    `INSERT INTO leave_balance_ledger
       (employee_uuid, leave_type_id, allocation_id, transaction_type,
        credited_days, debited_days, previous_balance, updated_balance,
        related_leave_request_uuid, performed_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      employeeUuid,
      leaveTypeId,
      allocationId,
      transactionType,
      creditedDays,
      debitedDays,
      previousBalance,
      updatedBalance,
      leaveRequestUuid,
      performedBy,
      reason,
    ],
  );
}
