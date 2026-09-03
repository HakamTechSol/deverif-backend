-- Audit pass fixes (2026-08-21)

-- 1. leave_requests.approved_by stores a uuid from EITHER users OR
--    admin_profiles (polymorphic), so a hard FK to users(uuid) makes every
--    platform-admin approval fail with ER_NO_REFERENCED_ROW_2 (500).
--    Replace the FK with a plain index; integrity is enforced at app level.
ALTER TABLE leave_requests DROP FOREIGN KEY fk_leave_requests_approved_by;
ALTER TABLE leave_requests
  DROP INDEX fk_leave_requests_approved_by,
  ADD INDEX idx_leave_requests_approved_by (approved_by);

-- 2. audit_logs grows fastest of all tables and the Activity Logs filter UI
--    queries actor_type+date and action+date. Single-column indexes forced
--    full scans / late filtering (~720ms p50 at 100k rows). Compound indexes
--    serve both filter shapes directly.
ALTER TABLE audit_logs
  ADD INDEX idx_audit_actor_date (actor_type, created_at),
  ADD INDEX idx_audit_action_date (action, created_at);
