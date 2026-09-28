import { Router } from "express";

import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  listDocumentTypes,
  createDocumentType,
  updateDocumentType,
  deleteDocumentType,
  getDocumentTypeSyncStatus,
} from "../../controllers/admin/documentTypes.controller.js";

const router = Router();

// System-admin only. The catalogue is a platform-wide setting, so an org admin
// has no route to it at all — and the org-facing read endpoint below exposes
// only the labels it needs to populate a dropdown.
router.get("/", authAdminEnv, asyncHandler(listDocumentTypes));
router.get("/sync-status", authAdminEnv, asyncHandler(getDocumentTypeSyncStatus));
router.post("/", authAdminEnv, asyncHandler(createDocumentType));
router.put("/:id", authAdminEnv, asyncHandler(updateDocumentType));
router.delete("/:id", authAdminEnv, asyncHandler(deleteDocumentType));

export default router;
