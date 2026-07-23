import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import { refreshAccessToken } from "../controllers/auth.refresh.controller.js";

const router = Router();

router.post("/refresh", asyncHandler(refreshAccessToken));

export default router;
