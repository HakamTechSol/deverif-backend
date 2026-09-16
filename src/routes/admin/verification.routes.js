import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  acceptNullOrganizationRequest,
  adminActOnSlaRequest,
  adminVerifyUnmatchedRequest,
  getUnmatchedOrgDetail,
  listAllRequests,
  listNullOrganizationRequests,
  listSlaFlaggedRequests,
  lockRequest,
  unlockRequest
} from "../../controllers/admin/verification.controller.js";
import { downloadCertificate } from "../../controllers/certificate.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listAllRequests));
router.get("/null-organization", authAdminEnv, asyncHandler(listNullOrganizationRequests));
router.get("/null-organization/:uuid", authAdminEnv, asyncHandler(getUnmatchedOrgDetail));
router.patch("/null-organization/:uuid/verify", authAdminEnv, asyncHandler(adminVerifyUnmatchedRequest));
router.get("/sla", authAdminEnv, asyncHandler(listSlaFlaggedRequests));
router.patch("/sla/:uuid", authAdminEnv, asyncHandler(adminActOnSlaRequest));
router.patch("/:uuid/accept", authAdminEnv, asyncHandler(acceptNullOrganizationRequest));
router.patch("/:uuid/lock", authAdminEnv, asyncHandler(lockRequest));
router.patch("/:uuid/unlock", authAdminEnv, asyncHandler(unlockRequest));
router.get("/:uuid/certificate", authAdminEnv, asyncHandler(downloadCertificate));

export default router;