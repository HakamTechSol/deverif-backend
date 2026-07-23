import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import { adminLogin, adminMe, logoutAdmin, updateAdminProfile } from "../../controllers/admin/auth.controller.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { loginLimiter } from "../../middleware/rateLimiter.js";
import { uploadProfile } from "../../middleware/uploadProfile.js";

const router = Router();

router.post("/login", loginLimiter, asyncHandler(adminLogin));
router.post("/logout", authAdminEnv, asyncHandler(logoutAdmin));
router.get("/me", authAdminEnv, asyncHandler(adminMe));
router.patch("/profile", authAdminEnv, uploadProfile.single("profile_image"), asyncHandler(updateAdminProfile));

export default router;
