import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authAny from "../middleware/authAny.js";
import { getAuthenticatedDocument } from "../controllers/documents.controller.js";

const router = Router();

// Authenticated, ownership-checked document downloads (no public static mount).
router.get("/:type/:filename", authAny, asyncHandler(getAuthenticatedDocument));

export default router;