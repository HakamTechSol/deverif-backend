import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { uploadProfile } from "../../middleware/uploadProfile.js";

import {
  listUsers,
  createUserWithOrganization,
  updateUser,
  deleteUser,
  resendInvite
} from "../../controllers/admin/users.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listUsers));
router.post("/", authAdminEnv, uploadProfile.single("profile_image"), asyncHandler(createUserWithOrganization));
router.put("/:uuid", authAdminEnv, asyncHandler(updateUser));
router.delete("/:uuid", authAdminEnv, asyncHandler(deleteUser));
router.post("/:uuid/resend-invite", authAdminEnv, asyncHandler(resendInvite));

export default router;