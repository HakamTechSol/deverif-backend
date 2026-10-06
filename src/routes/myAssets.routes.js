import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { listMyAssets } from "../controllers/org/assets.controller.js";

/**
 * Employee self-service: MY assets.
 *
 * Mounted at the top level (/my-assets), NOT under /org/*, because this is the
 * employee portal rather than a staff module. Same reasoning as /my-letters:
 * the controller derives the employee from the JWT, so there is no parameter a
 * caller could change to read someone else's hardware.
 *
 * Plan-gated on asset_management, matching the staff routes. An organization
 * whose plan excludes the asset module has no assets to hand out, so exposing
 * this page would only ever render an empty list and imply a bug.
 *
 * Note this is NOT restricted to the "employee" role the way /my-letters is.
 * Any org user with an employee record may see what is assigned to them, because
 * a sub-admin who is also on the roster is holding a laptop like anyone else.
 * Someone with no employee record gets an empty list rather than a 403.
 */
const router = Router();

router.use(authUser);

// authUser first so req.user AND req.scopeOrgId exist. The role check is
// intentionally absent, see the note above; authUser is what publishes the
// organization the controller scopes the query to.
const selfService = [
  requireActiveSubscription,
  requireModuleFeature("asset_management"),
];

router.get("/", selfService, asyncHandler(listMyAssets));

export default router;