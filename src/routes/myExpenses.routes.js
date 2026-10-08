import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { uploadAttachments } from "../middleware/uploadAttachments.js";
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

router.get("/", selfService, asyncHandler(myExpenseClaims));
router.get("/:uuid", selfService, asyncHandler(myExpenseClaimDetail));
router.post("/", selfService, asyncHandler(submitMyExpenseClaim));

/**
 * Receipts on the employee's OWN claim.
 *
 * These exist because a receipt-required category cannot be approved without one,
 * and the employee is the only person who has the till slip. Without these routes
 * the ESS portal could file a claim and then do nothing about the receipt that
 * decides whether it is approved - the employee would have to email finance and
 * wait, which is the exact workflow the portal was meant to replace.
 *
 * Every handler here re-derives the caller and then proves the claim is THEIRS.
 * The staff equivalents are org-gated and would return 403 to an employee; and
 * simply removing the gate would expose every claim in the tenant, since these
 * paths take a uuid.
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