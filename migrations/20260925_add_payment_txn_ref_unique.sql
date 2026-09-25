-- 2026-09-25 — payment.transaction_reference UNIQUE
--
-- Deduplication boundary for payment callbacks/webhooks: every successful
-- provider transaction reference must map to exactly ONE payment row, so a
-- duplicated delivery of the same payment is detected idempotently instead of
-- recording the payment (and extending the subscription) a second time.
--
-- Non-destructive: ADDs a UNIQUE KEY only. The payment table was verified to
-- contain zero rows and zero duplicate transaction_reference values before the
-- constraint is applied.
ALTER TABLE `payment`
  ADD UNIQUE KEY `uq_payment_txn_ref` (`transaction_reference`);