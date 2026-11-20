import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import requirePermission from "../middleware/requirePermission.js";
import ApiError from "../utils/ApiError.js";
import { createLeaveLimiter } from "../middleware/rateLimiter.js";
import {
  createLeave,
  decideLeave,
  cancelLeave,
  myLeaveBalances,
  myLeaveCalendar,
  myLeaves,
  orgLeaveTypes,
} from "../controllers/leave.controller.js";

const router = Router();

// Self-service leave: only the `employee` role uses it. Staff (org_admin /
// sub_admin) review rather than submit, and are handled via /org/leaves & decide.
// Both are gated by requireActiveSubscription so leave only works with an
// active org subscription, then by the plan's leave_management flag.
const employeesOnly = [requireRole("employee"), requireActiveSubscription, requireModuleFeature("leave_management")];
// Staff decisions are split by outcome; a sub-admin must hold the exact action.
const staff = [requireRole("org_admin", "sub_admin"), requireActiveSubscription, requireModuleFeature("leave_management")];
const mayDecideLeave = (req, res, next) => {
  if (!["approved", "rejected"].includes(req.body?.status)) return next();
  const permission = req.body.status === "approved" ? "leave_management.approve" : "leave_management.reject";
  return requirePermission(permission)(req, res, next);
};
const mayCancelLeave = (req, res, next) => {
  if (req.user?.org_role !== "sub_admin") return next();
  return next(new ApiError(403, "Sub-admin leave cancellation is not available"));
};
const leaveParticipants = [requireRole("employee", "org_admin", "sub_admin"), requireActiveSubscription, requireModuleFeature("leave_management")];

router.use(authUser);

router.get("/types", employeesOnly, asyncHandler(orgLeaveTypes));
router.get("/calendar", employeesOnly, asyncHandler(myLeaveCalendar));
router.get("/balance", employeesOnly, asyncHandler(myLeaveBalances));
router.get("/mine", employeesOnly, asyncHandler(myLeaves));
router.post("/", employeesOnly, createLeaveLimiter, asyncHandler(createLeave));

// Leave decision: org_admin or sub_admin may approve/reject.
router.patch("/:uuid/decide", staff, mayDecideLeave, asyncHandler(decideLeave));
router.patch("/:uuid/cancel", leaveParticipants, mayCancelLeave, asyncHandler(cancelLeave));

export default router;
