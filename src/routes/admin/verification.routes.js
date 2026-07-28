import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  acceptNullOrganizationRequest,
  adminVerifyUnmatchedRequest,
  deleteRequest,
  getUnmatchedOrgDetail,
  listAllRequests,
  listNullOrganizationRequests,
  lockRequest,
  unlockRequest
} from "../../controllers/admin/verification.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listAllRequests));
router.get("/null-organization", authAdminEnv, asyncHandler(listNullOrganizationRequests));
router.get("/null-organization/:uuid", authAdminEnv, asyncHandler(getUnmatchedOrgDetail));
router.patch("/null-organization/:uuid/verify", authAdminEnv, asyncHandler(adminVerifyUnmatchedRequest));
router.patch("/:uuid/accept", authAdminEnv, asyncHandler(acceptNullOrganizationRequest));
router.patch("/:uuid/lock", authAdminEnv, asyncHandler(lockRequest));
router.patch("/:uuid/unlock", authAdminEnv, asyncHandler(unlockRequest));
router.delete("/:uuid", authAdminEnv, asyncHandler(deleteRequest));

export default router;