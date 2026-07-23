import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { login } from "../controllers/auth.login.controller.js";
import { loginLimiter } from "../middleware/rateLimiter.js";

const router = Router();

router.post("/login", loginLimiter, asyncHandler(login));

export default router;
