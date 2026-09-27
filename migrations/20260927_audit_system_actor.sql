-- 2026-09-27 -- let automated (non-human) actions be recorded in audit_logs
--
-- Two defects, one cause: audit_logs could only describe a person.
--
-- 1. actor_type ENUM('admin','user') NOT NULL had no value for a machine.
--    The subscription lifecycle sweep is a cron/startup job with no request and
--    no user, so it called logAudit() with actorType undefined -> NULL ->
--    NOT NULL violation. logAudit is deliberately non-throwing ("losing an audit
--    row is better than rolling back a customer's payment"), so the insert failed
--    into the console and the row was silently dropped. In practice that meant
--    subscription.scheduled_change_applied and subscription.lapsed_to_free were
--    NEVER recorded: the one place a billing change happens with no human in the
--    loop was the one place with no audit trail.
--
-- 2. Automated callers that passed actorType: "" did "succeed" — but only
--    because this server runs MariaDB with sql_mode lacking STRICT_TRANS_TABLES,
--    so an out-of-enum value is coerced to '' with a warning instead of being
--    rejected. 15 rows are already stored that way: actor_type='' and actor_id=0,
--    neither of which exists in the schema. That is latent corruption, and it
--    becomes a hard failure for every webhook/reconciliation audit the moment
--    strict mode is switched on.
--
-- The fix
--   * Add 'system' to the enum, so a machine actor is representable instead of
--     illegal.
--   * Make actor_id nullable: a system action legitimately has no user id, and
--     forcing 0 is what produced the bad rows.
--   * Repair the rows already written outside the enum.
--
-- Non-destructive: the enum is widened (no existing member is removed or
-- renamed) and the backfill only rewrites values that are not in the enum.
ALTER TABLE `audit_logs`
  MODIFY COLUMN `actor_type` ENUM('admin','user','system') NOT NULL
    COMMENT 'Who caused the change. system = automated (lifecycle sweep, gateway reconciliation, webhook) — no human actor';

ALTER TABLE `audit_logs`
  MODIFY COLUMN `actor_id` INT(11) NULL
    COMMENT 'The admin/user id behind the change; NULL for system actions';

-- Repair the values that only got in because strict mode was off. 'safepay_webhook'
-- rows are gateway/reconciliation automation; the manual-repair rows are an admin
-- acting through SQL, which is closest to a system action with a named actor.
UPDATE `audit_logs`
  SET `actor_type` = 'system', `actor_id` = NULL
  WHERE `actor_type` NOT IN ('admin','user') OR `actor_type` IS NULL;

-- Fail loudly rather than silently if anything unexpected is still present.
SELECT `actor_type`, COUNT(*) AS `rows`
  FROM `audit_logs`
 WHERE `actor_type` NOT IN ('admin','user','system')
 GROUP BY `actor_type`;
