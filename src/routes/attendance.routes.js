import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
import { attendanceLimiter } from "../middleware/rateLimiter.js";
import { checkIn, checkOut, todayStatus, myAttendanceHistory } from "../controllers/attendance.controller.js";

const router = Router();

// Self-service attendance: only the `employee` role signs in/out. Staff manage
// attendance org-wide through /org/attendance instead.
const employeesOnly = requireRole("employee");

router.use(authUser);

router.post("/check-in", employeesOnly, attendanceLimiter, asyncHandler(checkIn));
router.post("/check-out", employeesOnly, attendanceLimiter, asyncHandler(checkOut));
router.get("/today", employeesOnly, asyncHandler(todayStatus));
router.get("/history", employeesOnly, asyncHandler(myAttendanceHistory));

export default router;
