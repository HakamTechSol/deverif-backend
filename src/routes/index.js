import { Router } from "express";
import ApiError from "../utils/ApiError.js";

import unifiedAuth from "./auth.routes.js";
import userAuth from "./auth.user.routes.js";
import refreshAuth from "./auth.refresh.routes.js";
import userRoutes from "./user.routes.js";
import verificationRoutes from "./verification.routes.js";
import paymentRoutes from "./payment.routes.js";
import notificationRoutes from "./notification.routes.js";

import adminAuth from "./admin/auth.routes.js";
import adminUsers from "./admin/users.routes.js";
import adminOrganizations from "./admin/organizations.routes.js";
import {
  listOrganizationTypes,
  createOrganizationType,
  deleteOrganizationType,
} from "../controllers/admin/organizations.controller.js";
import adminVerification from "./admin/verification.routes.js";
import adminPayment from "./admin/payment.routes.js";
import leadsRoutes from "./leads.routes.js";
import adminLeads from "./admin/leads.routes.js";
import adminLoginHistory from "./admin/loginHistory.routes.js";
import adminAuditLog from "./admin/auditLog.routes.js";
import dashboardRoutes from "./dashboard.routes.js";
import orgRoutes from "./org.routes.js";
import verifyRoutes from "./verify.routes.js";
import leavesRoutes from "./leaves.routes.js";
import attendanceRoutes from "./attendance.routes.js";
import salarySelfRoutes from "./salary.routes.js";
import supportRoutes from "./support.routes.js";
import adminSupport from "./admin/support.routes.js";
import orgSubscriptionRoutes from "./orgSubscription.routes.js";
import paymentWebhookRoutes from "./paymentWebhook.routes.js";
import adminSubscription from "./admin/subscription.routes.js";
import adminPlans from "./admin/plans.routes.js";
import marketingRoutes from "./marketing.routes.js";

import asyncHandler from "../utils/asyncHandler.js";
import authAdminEnv from "../middleware/authAdminEnv.js";

const orgTypesRouter = Router();
orgTypesRouter.get("/", authAdminEnv, asyncHandler(listOrganizationTypes));
orgTypesRouter.post("/", authAdminEnv, asyncHandler(createOrganizationType));
orgTypesRouter.delete("/:id", authAdminEnv, asyncHandler(deleteOrganizationType));

const router = Router();

router.use("/", dashboardRoutes);

// Public marketing data (no auth) — consumed by the marketing/landing site.
router.use("/marketing", marketingRoutes);

// Public QR verification (no auth)
router.use("/verify", verifyRoutes);

router.use("/leads", leadsRoutes);

// Public payment-gateway webhooks (signature-verified inside the handler).
router.use("/webhooks/payment-gateway", paymentWebhookRoutes);

router.use("/org", orgRoutes);
router.use("/org/support", supportRoutes);
router.use("/org/subscription", orgSubscriptionRoutes);

// Unified login (determines admin vs user automatically)
router.use("/auth", unifiedAuth);

// Token refresh
router.use("/auth", refreshAuth);

// USER/HR side
router.use("/auth/user", userAuth);
router.use("/users", userRoutes);
router.use("/verification-requests", verificationRoutes);
router.use("/payment", paymentRoutes);
router.use("/notifications", notificationRoutes);
router.use("/leaves", leavesRoutes);
router.use("/attendance", attendanceRoutes);
router.use("/salary-records", salarySelfRoutes);

// ADMIN side
router.use("/admin/auth", adminAuth);
router.use("/admin/users", adminUsers);
router.use("/admin/organizations", adminOrganizations);
router.use("/admin/organization-types", orgTypesRouter);
router.use("/admin/verification-requests", adminVerification);
router.use("/admin/payment", adminPayment);
router.use("/admin/leads", adminLeads);
router.use("/admin/login-history", adminLoginHistory);
router.use("/admin/audit-logs", adminAuditLog);
router.use("/admin/support-tickets", adminSupport);
router.use("/admin/subscription", adminSubscription);
router.use("/admin/plans", adminPlans);

// Org-internal modules (employees, leave, attendance, payroll/salary) are 100%
// Org-Admin-scoped. The System Admin must have NO access — not even view-only.
// Explicit 403 (instead of 404) so it's clear the block is intentional. Org
// admins reach these through /org/* with org-scoped JWTs.
function forbidOrgScopedModule(req, res, next) {
  next(
    new ApiError(
      403,
      "Platform admins do not have access to organization-scoped modules (employees, leave, attendance, payroll)"
    )
  );
}
[
  "/admin/employees",
  "/admin/leaves",
  "/admin/attendance",
  "/admin/salary-records",
].forEach((p) => {
  router.use(p, forbidOrgScopedModule);
});

export default router;
