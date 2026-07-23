import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import { listPayments, createPayment } from "../../controllers/admin/payment.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listPayments));
router.post("/", authAdminEnv, asyncHandler(createPayment));

export default router;
