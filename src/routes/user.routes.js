import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import { getMe, updateMe } from "../controllers/user.controller.js";
import { uploadProfile } from "../middleware/uploadProfile.js";

const router = Router();

router.get("/me", authUser, asyncHandler(getMe));

router.patch(
  "/me",
  authUser,
  uploadProfile.single("profile_image"),
  asyncHandler(updateMe)
);

export default router;