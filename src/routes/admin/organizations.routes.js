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
  cancelOrganizationSubscription,
  listOrganizationTypes,
  createOrganizationType,
  deleteOrganizationType
} from "../../controllers/admin/organizations.controller.js";

const router = Router();

router.get("/organization-types", authAdminEnv, asyncHandler(listOrganizationTypes));
router.post("/organization-types", authAdminEnv, asyncHandler(createOrganizationType));
router.delete("/organization-types/:id", authAdminEnv, asyncHandler(deleteOrganizationType));
router.get("/", authAdminEnv, asyncHandler(listOrganizations));
router.post("/", authAdminEnv, uploadOrganizationLogo.single("logo"), asyncHandler(createOrganization));
router.put("/:uuid", authAdminEnv, uploadOrganizationLogo.single("logo"), asyncHandler(updateOrganization));
router.delete("/:uuid", authAdminEnv, asyncHandler(deleteOrganization));
router.patch("/:uuid/subscription", authAdminEnv, asyncHandler(setOrganizationSubscription));
router.delete("/:uuid/subscription", authAdminEnv, asyncHandler(cancelOrganizationSubscription));

export default router;