-- 2026-09-13 Phase 2 — drop dead `leave_balances` table.
--
-- `leave_balances` is fully dead:
--   - No SELECT/UPDATE anywhere in backend or frontend code.
--   - Only ever written by `ensureBalance` / `ensureBalancesForEmployee` in
--     utils/leaveBalance.js — both dead exports (never imported/called; that
--     logic now lives in employee_leave_allocations via leaveAllocation.controller).
--   - Contains 0 rows in the live DB.
--
-- `employee_leave_allocations` is the live balance table (GET /leaves/balance,
-- leave approval deductions, org allocation CRUD all read/write it).
--
-- Data check before this migration: leave_balances had 0 rows — nothing to migrate.

DROP TABLE `leave_balances`;