import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { login } from "../controllers/auth.login.controller.js";
import { verifyOtp, resendOtp } from "../controllers/auth.otp.controller.js";
import { loginLimiter, otpLimiter } from "../middleware/rateLimiter.js";

const router = Router();

router.post("/login", loginLimiter, asyncHandler(login));
router.post("/verify-otp", otpLimiter, asyncHandler(verifyOtp));
router.post("/resend-otp", otpLimiter, asyncHandler(resendOtp));

export default router;
