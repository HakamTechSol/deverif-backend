import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { uploadOrganizationLogo } from "../../middleware/uploadOrganizationLogo.js";
import {
  listOrganizations,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  setOrganizationSubscription,
  cancelOrganizationSubscription
} from "../../controllers/admin/organizations.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listOrganizations));
router.post("/", authAdminEnv, uploadOrganizationLogo.single("logo"), asyncHandler(createOrganization));
router.put("/:uuid", authAdminEnv, uploadOrganizationLogo.single("logo"), asyncHandler(updateOrganization));
router.delete("/:uuid", authAdminEnv, asyncHandler(deleteOrganization));
router.patch("/:uuid/subscription", authAdminEnv, asyncHandler(setOrganizationSubscription));
router.delete("/:uuid/subscription", authAdminEnv, asyncHandler(cancelOrganizationSubscription));

export default router;