import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { myExit, submitMyResignation } from "../controllers/org/offboarding.controller.js";

/**
 * Employee self-service: my resignation.
 *
 * authUser and NOT requireRole, for the same reason /my/assets does it that way:
 * the employee portal must render for every org user, because a sub-admin who is
 * also on the roster is an employee who can hand in a notice. A role check here
 * would deny exactly the people it should serve.
 *
 * The cost of that choice is that authUser is the only thing publishing the org
 * scope, so the controller reads `req.scopeOrgId ?? req.user.organization` and
 * derives the employee from the session. Neither is taken from the request body -
 * see the controller for why that matters more here than on any other route.
 */
const router = Router();

router.use(authUser);

const selfService = [
  requireActiveSubscription,
  requireModuleFeature("separation_management"),
];

router.get("/", selfService, asyncHandler(myExit));
router.post("/", selfService, asyncHandler(submitMyResignation));

export default router;