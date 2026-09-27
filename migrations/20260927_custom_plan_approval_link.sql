-- 2026-09-27 -- link an approved custom-plan request to the plan it created
--
-- Approving a custom-plan request inserts a subscription_plans row
-- (is_custom=1, is_public=0) and then marks the request approved. Until now the
-- two were never linked: custom_plan_requests recorded the NEGOTIATED OUTCOME
-- (approved_daily_quota, approved_price) but not which plan row that outcome
-- produced.
--
-- Why that matters
--   An org admin looking at an approved request had no way to act on it. Approval
--   also opens a 'pending' checkout, but nothing in the app can pay it: POST
--   /org/subscription/checkout only accepts `is_custom=0 AND is_public=1`, and a
--   custom plan is deliberately never public. So the approved plan was
--   unreachable — an approval could be recorded but never completed.
--
-- approved_plan_id
--   The subscription_plans row this approval created. Nullable because an
--   unlinkable request must stay honestly unlinked rather than be wired to the
--   wrong plan; the checkout endpoint treats NULL as "nothing to activate".
--
-- Backfill strategy — deliberately NOT the plan name
--   subscription_plans has no organization_id; the only textual link is the
--   generated name, and that is not trustworthy: stored names use an em dash
--   (U+2014) while the approval code builds an ASCII hyphen, so a name match
--   matches nothing. Plan names are also not unique per org. So:
--
--     1. Exact: follow the checkout the approval itself created. Its metadata
--        carries custom_plan_request_uuid, so request -> checkout -> plan_id is a
--        real recorded edge, not an inference.
--     2. Fallback: only for approved requests with no such checkout, match the
--        approved quota AND price against custom plans, and only when exactly one
--        candidate exists. An ambiguous request is left NULL on purpose.
--
-- Non-destructive: one nullable column, one index, and a backfill that only ever
-- writes to rows that are still NULL.
ALTER TABLE `custom_plan_requests`
  ADD COLUMN IF NOT EXISTS `approved_plan_id` INT(11) NULL
    COMMENT 'The subscription_plans row created by this approval; NULL means no plan is linked to this request'
    AFTER `approved_price`;

CREATE INDEX `idx_cpr_approved_plan`
  ON `custom_plan_requests` (`approved_plan_id`);

-- 1. Exact backfill via the checkout the approval created.
UPDATE `custom_plan_requests` cpr
  JOIN `subscription_checkouts` sco
    ON sco.`metadata` LIKE CONCAT('%', cpr.`uuid`, '%')
   AND sco.`plan_id` IS NOT NULL
  SET cpr.`approved_plan_id` = sco.`plan_id`
  WHERE cpr.`status` = 'approved'
    AND cpr.`approved_plan_id` IS NULL;

-- 2. Conservative fallback for approvals predating the checkout: unique
--    quota + price match only.
UPDATE `custom_plan_requests` cpr
  JOIN `subscription_plans` sp
    ON  sp.`is_custom` = 1
    AND sp.`daily_request_quota` = cpr.`approved_daily_quota`
    AND sp.`monthly_price` = cpr.`approved_price`
  SET cpr.`approved_plan_id` = sp.`id`
  WHERE cpr.`status` = 'approved'
    AND cpr.`approved_plan_id` IS NULL
    AND (
      SELECT COUNT(*)
        FROM `subscription_plans` sp2
       WHERE sp2.`is_custom` = 1
         AND sp2.`daily_request_quota` = cpr.`approved_daily_quota`
         AND sp2.`monthly_price` = cpr.`approved_price`
    ) = 1;
