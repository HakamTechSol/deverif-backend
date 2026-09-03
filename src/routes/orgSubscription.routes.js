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
  getSubscriptionStatus,
  getCheckout,
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
router.get("/checkout/:checkoutId", orgAdminsOnly, asyncHandler(getCheckout));

export default router;