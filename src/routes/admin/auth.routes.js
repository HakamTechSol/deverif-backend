import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import { adminForgotPassword, adminLogin, adminMe, adminResetPassword, adminResendOtp, adminVerifyOtp, logoutAdmin, setAdminPreferredLanguage, updateAdminProfile } from "../../controllers/admin/auth.controller.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { loginLimiter, otpLimiter, forgotPasswordLimiter } from "../../middleware/rateLimiter.js";
import { uploadProfile } from "../../middleware/uploadProfile.js";

const router = Router();

router.post("/login", loginLimiter, asyncHandler(adminLogin));
router.post("/verify-otp", otpLimiter, asyncHandler(adminVerifyOtp));
router.post("/resend-otp", otpLimiter, asyncHandler(adminResendOtp));
router.post("/forgot-password", forgotPasswordLimiter, asyncHandler(adminForgotPassword));
router.post("/reset-password", asyncHandler(adminResetPassword));
router.post("/logout", authAdminEnv, asyncHandler(logoutAdmin));
router.get("/me", authAdminEnv, asyncHandler(adminMe));
router.patch("/profile", authAdminEnv, uploadProfile.single("profile_image"), asyncHandler(updateAdminProfile));
router.patch("/me/preferred-language", authAdminEnv, asyncHandler(setAdminPreferredLanguage));

export default router;
