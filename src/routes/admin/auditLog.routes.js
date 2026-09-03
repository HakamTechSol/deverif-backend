import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { listAuditLogs, listAuditActions } from "../../controllers/admin/auditLog.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listAuditLogs));
router.get("/actions", authAdminEnv, asyncHandler(listAuditActions));

export default router;