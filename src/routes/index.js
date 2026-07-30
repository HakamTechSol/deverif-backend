import { Router } from "express";

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
import adminVerification from "./admin/verification.routes.js";
import adminPayment from "./admin/payment.routes.js";
import leadsRoutes from "./leads.routes.js";
import adminLeads from "./admin/leads.routes.js";
import dashboardRoutes from "./dashboard.routes.js";

const router = Router();

router.use("/", dashboardRoutes);

router.use("/leads", leadsRoutes);

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

// ADMIN side
router.use("/admin/auth", adminAuth);
router.use("/admin/users", adminUsers);
router.use("/admin/organizations", adminOrganizations);
router.use("/admin/verification-requests", adminVerification);
router.use("/admin/payment", adminPayment);
router.use("/admin/leads", adminLeads);

export default router;
