import { Router } from "express";

import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { downloadDatabaseBackup } from "../../controllers/admin/databaseBackup.controller.js";

const router = Router();

/**
 * Full logical database backup (schema + data) as a downloadable .sql file.
 *
 * System-admin only. The file contains credentials and encrypted personal data
 * for every user, so this is deliberately not on any org-facing route and every
 * run is written to the audit log with the acting admin.
 */
router.get("/backup", authAdminEnv, asyncHandler(downloadDatabaseBackup));

export default router;
