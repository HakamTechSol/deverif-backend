import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { uploadAttachments } from "../middleware/uploadAttachments.js";
import { hasPermission } from "../utils/permissions.js";
import ApiError from "../utils/ApiError.js";
import {
  myExpenseClaims,
  submitMyExpenseClaim,
  myExpenseClaimDetail,
  uploadMyExpenseReceipts,
  removeMyExpenseReceipt,
  downloadMyExpenseReceipt,
} from "../controllers/org/expenses.controller.js";

/**
 * Employee self-service: MY expense claims.
 *
 * Mounted at the top level (/my-expenses), NOT under /org/*, because this is the
 * employee portal rather than a staff module — same reasoning as /my-assets.
 *
 * Plan-gated on expense_management, matching the staff routes. A module an org has
 * not bought cannot have claims filed against it.
 *
 * The role check present on /my-letters is deliberately ABSENT here, and this is a
 * real difference rather than an oversight: letters are a document the company
 * issues, whereas a claim is a submission the employee makes. A sub-admin who is
 * also on the roster has expenses to reclaim exactly like anyone else, and gating
 * them out of their own reimbursement would be a bug.
 *
 * As in the assets controller, the employee is derived from the JWT and no handler
 * accepts an employee_uuid, so there is no parameter a caller could change to file
 * or read someone else's claim.
 */
const router = Router();

router.use(authUser);

// authUser first so req.user AND req.scopeOrgId exist.
const selfService = [requireActiveSubscription, requireModuleFeature("expense_management")];

const mayCreateOwnClaim = (req, _res, next) => {
  if (req.user?.org_role === "employee" || req.user?.org_role === "org_admin") return next();
  if (req.user?.org_role === "sub_admin" && hasPermission(req.user, "expenses.create_own")) {
    return next();
  }
  return next(new ApiError(403, "You do not have permission to create an expense claim"));
};

router.get("/", selfService, asyncHandler(myExpenseClaims));
router.get("/:uuid", selfService, asyncHandler(myExpenseClaimDetail));
router.post("/", selfService, mayCreateOwnClaim, asyncHandler(submitMyExpenseClaim));

/**
 * Receipts on the employee's OWN claim.
 *
 * A receipt is optional, but when the employee has one this is where it is
 * attached: the staff routes are org-gated and would return 403 to an employee,
 * and simply removing the gate would expose every claim in the tenant, since these
 * paths take a uuid.
 *
 * Every handler here re-derives the caller and then proves the claim is THEIRS.
 */
router.post(
  "/:uuid/receipts",
  selfService,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadMyExpenseReceipts),
);
router.delete("/expense-attachments/:attachmentUuid", selfService, asyncHandler(removeMyExpenseReceipt));
router.get(
  "/expense-attachments/:attachmentUuid/download",
  selfService,
  asyncHandler(downloadMyExpenseReceipt),
);

export default router;