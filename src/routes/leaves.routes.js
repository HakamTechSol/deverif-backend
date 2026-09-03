import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
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
const employeesOnly = requireRole("employee");
// Approve/reject is shared staff access.
const staff = requireRole("org_admin", "sub_admin");

router.use(authUser);

router.get("/types", employeesOnly, asyncHandler(orgLeaveTypes));
router.get("/balance", employeesOnly, asyncHandler(myLeaveBalances));
router.get("/mine", employeesOnly, asyncHandler(myLeaves));
router.post("/", employeesOnly, createLeaveLimiter, asyncHandler(createLeave));

// Leave decision: org_admin or sub_admin may approve/reject.
router.patch("/:uuid/decide", staff, asyncHandler(decideLeave));

export default router;
