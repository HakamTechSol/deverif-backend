import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import authAny from "../middleware/authAny.js";
import authAdminEnv from "../middleware/authAdminEnv.js";
import {
  dashboardStats,
  adminDashboardStats,
  userRequestsCount,
  organizationCount,
  adminVerificationCount,
  adminRequestsCount
} from "../controllers/dashboard.controller.js";

const router = Router();

router.get("/dashboard", authAny, asyncHandler(dashboardStats));
router.get("/dashboard/user", authAny, asyncHandler(dashboardStats));
router.get("/dashboard/admin", authAdminEnv, asyncHandler(adminDashboardStats));

router.get("/user-requests", authUser, asyncHandler(userRequestsCount));
router.get("/organization", authAny, asyncHandler(organizationCount));
router.get("/admin-verification", authAdminEnv, asyncHandler(adminVerificationCount));
router.get("/admin-requests", authAdminEnv, asyncHandler(adminRequestsCount));

export default router;
