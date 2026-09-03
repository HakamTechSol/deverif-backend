import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { listPublicPlans } from "../controllers/marketing.controller.js";

const router = Router();

// Public marketing data (no auth) consumed by the marketing/landing site.
router.get("/plans", asyncHandler(listPublicPlans));

export default router;
