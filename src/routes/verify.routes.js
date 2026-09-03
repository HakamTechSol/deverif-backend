import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { publicVerifyLimiter } from "../middleware/rateLimiter.js";
import { verifyPublicQr } from "../controllers/verify.controller.js";

const router = Router();

router.get("/:qr_token", publicVerifyLimiter, asyncHandler(verifyPublicQr));

export default router;