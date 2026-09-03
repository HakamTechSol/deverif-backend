import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  listContactLeads,
  getContactLead,
  updateContactLeadStatus,
  listAccessRequests,
  getAccessRequest,
  updateAccessRequestStatus,
} from "../../controllers/leads.controller.js";

const router = Router();

router.get("/contact", authAdminEnv, asyncHandler(listContactLeads));
router.get("/contact/:uuid", authAdminEnv, asyncHandler(getContactLead));
router.patch("/contact/:uuid/status", authAdminEnv, asyncHandler(updateContactLeadStatus));

router.get("/request-access", authAdminEnv, asyncHandler(listAccessRequests));
router.get("/request-access/:uuid", authAdminEnv, asyncHandler(getAccessRequest));
router.patch("/request-access/:uuid/status", authAdminEnv, asyncHandler(updateAccessRequestStatus));

export default router;
