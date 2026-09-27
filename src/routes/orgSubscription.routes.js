import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import {
  myQuota,
  listOrgCustomPlanRequests,
  requestCustomPlan,
  selfSubscribe,
} from "../controllers/subscription.controller.js";
import {
  createCheckout,
  createCustomPlanCheckout,
  getSubscriptionStatus,
  getCheckout,
  cancelPendingPlan,
} from "../controllers/orgSubscription.controller.js";

const router = Router();

const orgUser = requireRole("org_admin", "sub_admin", "employee");
const orgAdminsOnly = requireRole("org_admin");

router.get("/quota", orgUser, asyncHandler(myQuota));
router.get("/custom-plan-requests", orgUser, asyncHandler(listOrgCustomPlanRequests));
router.post("/custom-plan-requests", orgUser, asyncHandler(requestCustomPlan));
router.post("/self-subscribe", orgAdminsOnly, asyncHandler(selfSubscribe));

router.get("/status", orgUser, asyncHandler(getSubscriptionStatus));
router.post("/checkout", orgAdminsOnly, asyncHandler(createCheckout));
// Paying for an approved custom plan. Separate from /checkout on purpose: a
// custom plan must never be self-service, so this path is the only way in and it
// requires an approved, plan-linked request belonging to this organization.
router.post("/custom-plan/checkout", orgAdminsOnly, asyncHandler(createCustomPlanCheckout));
router.get("/checkout/:checkoutId", orgAdminsOnly, asyncHandler(getCheckout));

// Cancel a deferred downgrade (pending_plan_id) before it takes effect.
router.delete("/pending-plan", orgAdminsOnly, asyncHandler(cancelPendingPlan));

export default router;