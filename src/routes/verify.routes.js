import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { publicVerifyLimiter, publicVerifyDocumentLimiter } from "../middleware/rateLimiter.js";
import { verifyPublicQr } from "../controllers/verify.controller.js";
import { streamPublicVerifiedDocument } from "../controllers/publicDocument.controller.js";

import { verifyPublicLetter } from "../controllers/org/hrLetters.controller.js";

const router = Router();

// HR Letter verification. Its own path segment under the same public /verify
// prefix, sharing the rate limiter.
//
// Registered BEFORE "/:qr_token" because a letter token and a document token
// share the same 64-hex shape: a single-segment matcher would treat "letter" as
// a token and 404, and that 404 would be ambiguous between "not found" and
// "misrouted". Separate segments keep the public surface unambiguous however
// either loader is later tightened.
router.get("/letter/:qr_token", publicVerifyLimiter, asyncHandler(verifyPublicLetter));

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
