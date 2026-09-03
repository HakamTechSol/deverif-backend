import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  listPlans,
  createPlan,
  updatePlan,
  togglePlanPublic,
  deletePlan,
} from "../../controllers/admin/plans.controller.js";

const router = Router();

router.get("/", authAdminEnv, asyncHandler(listPlans));
router.post("/", authAdminEnv, asyncHandler(createPlan));
router.put("/:uuid", authAdminEnv, asyncHandler(updatePlan));
router.post("/:uuid/publish", authAdminEnv, asyncHandler(togglePlanPublic));
router.delete("/:uuid", authAdminEnv, asyncHandler(deletePlan));

export default router;
