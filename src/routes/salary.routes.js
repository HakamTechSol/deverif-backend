import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
import { mySalaryRecords } from "../controllers/salary.controller.js";

const router = Router();

// Self-service payslips: only the `employee` role. Staff view the org payroll
// ledger through /org/* routes instead.
const employeesOnly = requireRole("employee");

router.use(authUser);

router.get("/mine", employeesOnly, asyncHandler(mySalaryRecords));

export default router;
