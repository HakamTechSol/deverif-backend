-- 2026-09-27 -- cancel-with-refund support for scheduled subscription changes
--
-- Two additions, both for the "schedule a renewal/downgrade now, change the plan
-- at expiry, and let the customer back out with a refund" flow.
--
-- 1) status gains 'refunded'.
--    A cancelled scheduled change must be REFUNDED (the customer paid for a
--    renewal that will now not happen). The checkout row is never deleted: it is
--    the ledger evidence of what was charged and what was given back, so
--    'refunded' is a terminal state on the row rather than a removal. 'cancelled'
--    is deliberately kept for the distinct case where nothing was ever captured
--    (e.g. a pending checkout abandoned before payment).
--
-- 2) resulted_in_pending_plan_id records which checkout PRODUCED the currently
--    scheduled change.
--
--    Without this there is no way to answer "which payment do I refund?" when an
--    org cancels a scheduled change. subscription_checkouts has no link to
--    organizations.pending_plan_id, and inferring it from (organization_id +
--    plan_id) is ambiguous: an org can schedule a change, cancel it, and schedule
--    another for the same plan, and the earlier checkout must not be refunded a
--    second time. Recording the link at the moment the webhook creates the
--    scheduled change makes the lookup exact.
--
--    It is written by the payment webhook's transition, so it is set exactly once
--    per scheduled change and is NULL for immediate activations (nothing was
--    scheduled) and for checkouts that never cleared payment.
--
-- Non-destructive: ENUM widened (existing values untouched), nullable column.
ALTER TABLE `subscription_checkouts`
  MODIFY COLUMN `status`
    ENUM('pending','completed','failed','cancelled','refunded','expired')
    NOT NULL DEFAULT 'pending';

ALTER TABLE `subscription_checkouts`
  ADD COLUMN IF NOT EXISTS `resulted_in_pending_plan_id` BIGINT UNSIGNED DEFAULT NULL
    COMMENT 'Plan this checkout scheduled via organizations.pending_plan_id; NULL when it applied immediately'
    AFTER `plan_id`;

-- Supports the cancel-with-refund lookup: "the completed checkout for this org
-- that scheduled this specific plan".
CREATE INDEX `idx_sco_pending_result`
  ON `subscription_checkouts` (`organization_id`, `resulted_in_pending_plan_id`, `status`);
