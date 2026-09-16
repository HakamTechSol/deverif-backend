-- 2026-09-13 Phase 5 — decouple subscriptions from users.
--
-- User-level subscriptions lived on users.subscription_plan /
-- users.subscription_expiry (a legacy individual-purchase model). Subscriptions
-- are now managed ONLY at the organization level (organizations.subscription_*
-- joined to subscription_plans). Verified before dropping:
--   * every row is inert: all 5 users are 'free' with a NULL expiry,
--   * no indexes or foreign keys reference these two columns,
--   * every backend/frontend reference was removed in the same pass:
--       - profile SELECTs (user.controller.js, middleware authUser/authAny/
--         requireRole, org/admin user-list SELECTs),
--       - user INSERTs (admin/users.controller.js, org/adminUsers.controller.js,
--         admin/employees.controller.js),
--       - admin user UPDATE (admin/users.controller.js),
--       - payment POST-payment path now activates the ORG's subscription
--         (payment.controller.js finalizeSuccessfulPayment),
--       - plan summary is org-only (utils/plan.js, payment.controller.js myPlan).

ALTER TABLE `users` DROP COLUMN `subscription_plan`;
ALTER TABLE `users` DROP COLUMN `subscription_expiry`;