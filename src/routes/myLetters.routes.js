import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import {
  listMyLetters,
  getMyLetter,
  downloadMyLetterPdf,
} from "../controllers/myLetters.controller.js";

/**
 * Employee self-service: MY letters.
 *
 * Mounted at the top level (/my-letters), NOT under /org/*, because this is the
 * employee portal rather than a staff module. Any org user signed in with an
 * employee record can read their own issued letters; nobody can read anyone
 * else's, because the controller derives the employee from the JWT rather than
 * from any id in the request.
 *
 * Plan-gated on hr_letters_management like the staff routes — an org whose plan
 * excludes HR Letters cannot publish letters to its staff either.
 */
const router = Router();

const employeeOnly = [
  requireRole("employee"),
  requireActiveSubscription,
  requireModuleFeature("hr_letters_management"),
];

// authUser first so req.user exists; requireRole then re-validates the JWT and
// resolves the live org_role, which is stricter than anything in the token alone.
router.use(authUser);
router.get("/", employeeOnly, asyncHandler(listMyLetters));
router.get("/:uuid", employeeOnly, asyncHandler(getMyLetter));
router.get("/:uuid/pdf", employeeOnly, asyncHandler(downloadMyLetterPdf));

export default router;