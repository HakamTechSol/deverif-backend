import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { forgotPassword, loginUser, logoutUser, resetPassword, setPassword, validateInviteToken } from "../controllers/auth.user.controller.js";
import authUser from "../middleware/authUser.js";
import { loginLimiter, forgotPasswordLimiter } from "../middleware/rateLimiter.js";

const router = Router();

router.post("/login", loginLimiter, asyncHandler(loginUser));
router.post("/logout", authUser, asyncHandler(logoutUser));
router.post("/forgot-password", forgotPasswordLimiter, asyncHandler(forgotPassword));
router.post("/reset-password", asyncHandler(resetPassword));
router.get("/invite-status", asyncHandler(validateInviteToken));
router.post("/set-password", asyncHandler(setPassword));

export default router;
