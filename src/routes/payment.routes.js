import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import {
	handlePaymentCallback,
	initiatePayment,
	myPlan,
	paymentProviders
} from "../controllers/payment.controller.js";

const router = Router();

router.get("/providers", asyncHandler(paymentProviders));
router.get("/callback/:provider", asyncHandler(handlePaymentCallback));
router.post("/callback/:provider", asyncHandler(handlePaymentCallback));
router.post("/initiate", authUser, asyncHandler(initiatePayment));
router.get("/plan", authUser, asyncHandler(myPlan));

export default router;
