import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { contactLeadLimiter, accessRequestLimiter } from "../middleware/rateLimiter.js";
import { submitContact, submitAccessRequest } from "../controllers/leads.controller.js";

const router = Router();

router.post("/contact", contactLeadLimiter, asyncHandler(submitContact));
router.post("/request-access", accessRequestLimiter, asyncHandler(submitAccessRequest));

export default router;
