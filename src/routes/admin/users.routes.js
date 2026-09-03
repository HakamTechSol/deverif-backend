import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { uploadUserFiles } from "../../middleware/uploadUserFiles.js";

import {
  listUsers,
  createUserWithOrganization,
  updateUser,
  deleteUser,
  resendInvite,
} from "../../controllers/admin/users.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listUsers));
router.post("/", authAdminEnv, uploadUserFiles.fields([
  { name: "profile_image", maxCount: 1 },
  { name: "org_logo", maxCount: 1 },
]), asyncHandler(createUserWithOrganization));
router.put("/:uuid", authAdminEnv, asyncHandler(updateUser));
router.delete("/:uuid", authAdminEnv, asyncHandler(deleteUser));
router.post("/:uuid/resend-invite", authAdminEnv, asyncHandler(resendInvite));

export default router;