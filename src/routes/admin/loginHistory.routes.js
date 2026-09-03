import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { listLoginHistory } from "../../controllers/admin/loginHistory.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listLoginHistory));

export default router;
