-- Merge `employees.record_type` into `employees.status`.
--
-- WHY: the two columns were always written together and always disagreed about
-- what they meant. `record_type` said roster-vs-ex-employee, `status` said
-- active-vs-resigned, and `archiveReference` had to write BOTH (`record_type=
-- 'learned_reference', status='resigned'`) to express one fact. Any read that
-- forgot the second column saw a "resigned" employee still sitting in the
-- active roster. One field removes that whole class of bug.
--
-- THE MAPPING. `record_type` is the primary axis (it drove every headcount,
-- roster and reference query), and `status` folds in only where it carried
-- information record_type did not:
--
--   roster            + active     -> current_employee   (the normal employee)
--   roster            + inactive   -> inactive           (deactivated — see below)
--   roster            + resigned   -> ex_employee
--   roster            + terminated -> ex_employee
--   learned_reference + anything   -> ex_employee
--
-- WHY 'inactive' SURVIVES. It looks like a lifecycle value that the merge could
-- absorb, but it is not: it is the DEACTIVATION kill-switch read by
-- middleware/authUser.js:31 and three login controllers. Dropping the enum value
-- would silently stop all four guards from ever firing, and because none of
-- them has a test, the suite would stay green while a deactivated employee kept
-- full API access. So 'inactive' is retained as a first-class value and is
-- simply not offered when CREATING an employee (there is nothing to deactivate
-- yet) — it appears only when editing, where deactivating is the actual action.
--
-- The four auth guards therefore keep working untouched, which is the main
-- reason this migration is safe to run.

ALTER TABLE `employees`
    MODIFY COLUMN `status`
    ENUM('active','inactive','current_employee','ex_employee') NOT NULL DEFAULT 'current_employee';

-- Backfill BEFORE dropping record_type, because the mapping needs both columns.
--
-- Order matters: the learned_reference rows are collapsed first so the roster
-- branch below cannot re-grant them 'current_employee'. createReference inserted
-- rows as record_type='learned_reference' WITH status='active', which the old
-- headcount query (`status='active' AND record_type='roster'`) happened to
-- exclude — so those rows must become ex_employee explicitly, or they start
-- counting as live staff the moment record_type stops existing.
UPDATE `employees` SET `status` = 'ex_employee'
    WHERE `record_type` = 'learned_reference';

UPDATE `employees` SET `status` = 'current_employee'
    WHERE `record_type` = 'roster' AND `status` IN ('active', 'resigned', 'terminated');

UPDATE `employees` SET `status` = 'ex_employee'
    WHERE `record_type` = 'roster' AND `status` = 'resigned';

UPDATE `employees` SET `status` = 'ex_employee'
    WHERE `record_type` = 'roster' AND `status` = 'terminated';

-- 'inactive' roster rows are left exactly as they are: they are deactivated
-- platform users, and the value means the same thing after the merge.

ALTER TABLE `employees` DROP COLUMN `record_type`;