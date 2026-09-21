import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { createLeaveLimiter } from "../middleware/rateLimiter.js";
import {
  createLeave,
  decideLeave,
  myLeaveBalances,
  myLeaves,
  orgLeaveTypes,
} from "../controllers/leave.controller.js";

const router = Router();

// Self-service leave: only the `employee` role uses it. Staff (org_admin /
// sub_admin) review rather than submit, and are handled via /org/leaves & decide.
// Both are gated by requireActiveSubscription so leave only works with an
// active org subscription, then by the plan's leave_management flag.
const employeesOnly = [requireRole("employee"), requireActiveSubscription, requireModuleFeature("leave_management")];
// Approve/reject is shared staff access.
const staff = [requireRole("org_admin", "sub_admin"), requireActiveSubscription, requireModuleFeature("leave_management")];

router.use(authUser);

router.get("/types", employeesOnly, asyncHandler(orgLeaveTypes));
router.get("/balance", employeesOnly, asyncHandler(myLeaveBalances));
router.get("/mine", employeesOnly, asyncHandler(myLeaves));
router.post("/", employeesOnly, createLeaveLimiter, asyncHandler(createLeave));

// Leave decision: org_admin or sub_admin may approve/reject.
router.patch("/:uuid/decide", staff, asyncHandler(decideLeave));

export default router;
