import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  listCustomPlanRequests,
  approveCustomPlanRequest,
  denyCustomPlanRequest,
  listSelfSubscriptionRequests,
  confirmSelfSubscriptionRequest,
  cancelSelfSubscriptionRequest,
  listSubscriptionCheckouts,
} from "../../controllers/admin/subscription.controller.js";

const router = Router();

router.get("/custom-plan-requests", authAdminEnv, asyncHandler(listCustomPlanRequests));
router.post("/custom-plan-requests/:uuid/approve", authAdminEnv, asyncHandler(approveCustomPlanRequest));
router.post("/custom-plan-requests/:uuid/deny", authAdminEnv, asyncHandler(denyCustomPlanRequest));

router.get("/checkouts", authAdminEnv, asyncHandler(listSubscriptionCheckouts));

router.get("/self-subscription-requests", authAdminEnv, asyncHandler(listSelfSubscriptionRequests));
router.post("/self-subscription-requests/:uuid/confirm", authAdminEnv, asyncHandler(confirmSelfSubscriptionRequest));
router.post("/self-subscription-requests/:uuid/cancel", authAdminEnv, asyncHandler(cancelSelfSubscriptionRequest));

export default router;
