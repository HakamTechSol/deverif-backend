import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { listContactLeads, listAccessRequests } from "../../controllers/leads.controller.js";

const router = Router();

router.get("/contact", authAdminEnv, asyncHandler(listContactLeads));
router.get("/request-access", authAdminEnv, asyncHandler(listAccessRequests));

export default router;
