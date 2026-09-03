import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import { getMe, setPreferredLanguage, updateMe } from "../controllers/user.controller.js";
import { uploadProfile } from "../middleware/uploadProfile.js";

const router = Router();

router.get("/me", authUser, asyncHandler(getMe));

router.patch(
  "/me",
  authUser,
  uploadProfile.single("profile_image"),
  asyncHandler(updateMe)
);

router.patch("/preferred-language", authUser, asyncHandler(setPreferredLanguage));

export default router;