import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { publicVerifyLimiter } from "../middleware/rateLimiter.js";
import { verifyPublicQr } from "../controllers/verify.controller.js";
import { streamPublicQrDocument } from "../controllers/documents.controller.js";

const router = Router();

// Public document stream for VERIFIED requests — gated by the QR token +
// HMAC signature, exactly like the metadata endpoint below. Must be registered
// before the generic /:qr_token match.
router.get(
  "/document/:filename",
  publicVerifyLimiter,
  asyncHandler(streamPublicQrDocument)
);

router.get("/:qr_token", publicVerifyLimiter, asyncHandler(verifyPublicQr));

export default router;