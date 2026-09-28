import { Router } from "express";

import asyncHandler from "../utils/asyncHandler.js";
import authAny from "../middleware/authAny.js";
import { listActiveDocumentTypes } from "../controllers/admin/documentTypes.controller.js";

const router = Router();

/**
 * The active document-type catalogue, for any signed-in user.
 *
 * An organization user needs the labels in order to pick one when submitting a
 * verification request or uploading an employee reference document, so this is
 * NOT admin-only. It exposes labels and schema keys only — no ids, no audit
 * fields, no internal state. Administration lives under /admin/document-types.
 */
router.get("/", authAny, asyncHandler(listActiveDocumentTypes));

export default router;
