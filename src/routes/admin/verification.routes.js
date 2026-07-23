import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  acceptNullOrganizationRequest,
  deleteRequest,
  listAllRequests,
  listNullOrganizationRequests
} from "../../controllers/admin/verification.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listAllRequests));
router.get("/null-organization", authAdminEnv, asyncHandler(listNullOrganizationRequests));
router.patch("/:uuid/accept", authAdminEnv, asyncHandler(acceptNullOrganizationRequest));
router.delete("/:uuid", authAdminEnv, asyncHandler(deleteRequest));

export default router;