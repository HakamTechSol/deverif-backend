import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { publicVerifyLimiter, publicVerifyDocumentLimiter } from "../middleware/rateLimiter.js";
import { verifyPublicQr } from "../controllers/verify.controller.js";
import { streamPublicVerifiedDocument } from "../controllers/publicDocument.controller.js";

const router = Router();

// Public document stream for a VERIFIED request, behind the same QR token and
// HMAC checks as the metadata endpoint. The filename comes from the database
// row, not from this URL — see the controller for why.
//
// Registered before the single-segment /:qr_token route so the two-segment path
// is never interpreted as a token.
router.get(
  "/:qr_token/document",
  publicVerifyDocumentLimiter,
  asyncHandler(streamPublicVerifiedDocument)
);

router.get("/:qr_token", publicVerifyLimiter, asyncHandler(verifyPublicQr));

export default router;
