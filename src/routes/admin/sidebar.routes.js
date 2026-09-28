import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { getSidebarCounts } from "../../controllers/admin/sidebar.controller.js";

const router = Router();
router.get("/sidebar-counts", authAdminEnv, asyncHandler(getSidebarCounts));
export default router;
