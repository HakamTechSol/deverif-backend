-- Recompute saved net salaries from the salary components already stored on each record.
-- This repairs records created with the former basic-minus-deductions calculation.
UPDATE `salary_records`
SET `net_salary` = GREATEST(
  0,
  ROUND(
    COALESCE(`basic_salary`, 0) + COALESCE(`allowances`, 0) - COALESCE(`deductions`, 0),
    2
  )
)
WHERE `net_salary` <> GREATEST(
  0,
  ROUND(
    COALESCE(`basic_salary`, 0) + COALESCE(`allowances`, 0) - COALESCE(`deductions`, 0),
    2
  )
);