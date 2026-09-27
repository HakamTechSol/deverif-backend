-- 2026-09-27 -- durable, traceable refunds for scheduled subscription changes
--
-- A "Cancel & Refund" must be provable after the fact: which charge was
-- reversed, and by which gateway reference. Without that, the only local trace
-- was a status flip, and reconciling against the gateway meant matching on an
-- amount.
--
-- refund_transaction_reference
--   The gateway's OWN reference for the refund (Safepay: refund_...). This is
--   the id to quote to the gateway when chasing a refund, and the value that ties
--   a local row back to the gateway's record. It is read back from the reporter
--   (attempts[*].refund.token), not just from the submit response, so it is
--   recoverable even if the original call's response was lost.
--
-- refund_status
--   none | pending | refunded | failed.
--   'pending' exists because a gateway may accept a refund and settle it
--   asynchronously. While pending, the scheduled change is NOT treated as
--   cancelled, and — critically — the row cannot be refunded again, which is what
--   stops a customer retrying into a DOUBLE REFUND.
--
-- status gains 'refund_pending' so a checkout that has been refunded but not yet
--   settled is distinguishable from both 'completed' (still fully paid) and
--   'refunded' (settled and reconciled).
--
-- refund_requested_at / refunded_at record when each transition happened, so a
-- refund that never settles is visible as a stuck row rather than silently
-- looking un-refunded.
--
-- The same columns go on `payment` because that is what the Billing History table
-- reads (controllers/payment.controller.js). Without them a refunded charge looks
-- identical to a live one to anyone reading the org's billing history.
--
-- Non-destructive: nullable columns plus a widened ENUM; no existing value is
-- rewritten. 'none' is the default so pre-existing rows are honestly "never
-- refunded" rather than silently implying otherwise.
ALTER TABLE `subscription_checkouts`
  MODIFY COLUMN `status`
    ENUM('pending','completed','failed','cancelled','refund_pending','refunded','expired')
    NOT NULL DEFAULT 'pending';

ALTER TABLE `subscription_checkouts`
  ADD COLUMN IF NOT EXISTS `refund_status`
    ENUM('none','pending','refunded','failed') NOT NULL DEFAULT 'none'
    COMMENT 'none = never refunded; pending = submitted, settlement not yet confirmed; refunded = gateway-confirmed'
    AFTER `resulted_in_pending_plan_id`;

ALTER TABLE `subscription_checkouts`
  ADD COLUMN IF NOT EXISTS `refund_transaction_reference` VARCHAR(255) DEFAULT NULL
    COMMENT 'Gateway reference for the refund (e.g. Safepay refund_...); the traceable link back to the original charge'
    AFTER `refund_status`;

ALTER TABLE `subscription_checkouts`
  ADD COLUMN IF NOT EXISTS `refund_requested_at` DATETIME NULL
    COMMENT 'When the refund was submitted to the gateway'
    AFTER `refund_transaction_reference`;

ALTER TABLE `subscription_checkouts`
  ADD COLUMN IF NOT EXISTS `refunded_at` DATETIME NULL
    COMMENT 'When the gateway confirmed the refund settled'
    AFTER `refund_requested_at`;

ALTER TABLE `payment`
  ADD COLUMN IF NOT EXISTS `refund_transaction_reference` VARCHAR(255) DEFAULT NULL
    COMMENT 'Gateway reference for the refund, mirrored from the linked checkout for billing-history reconciliation'
    AFTER `transaction_reference`;

ALTER TABLE `payment`
  ADD COLUMN IF NOT EXISTS `refunded_at` DATETIME NULL
    COMMENT 'When the gateway confirmed the refund settled'
    AFTER `refund_transaction_reference`;

-- Reconciliation query: "which charges were reversed, and did the gateway agree?"
CREATE INDEX `idx_sco_refund_status`
  ON `subscription_checkouts` (`organization_id`, `refund_status`);
