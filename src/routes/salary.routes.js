import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { mySalaryRecords } from "../controllers/salary.controller.js";

const router = Router();

// Self-service payslips: only the `employee` role. Staff view the org payroll
// ledger through /org/* routes instead. Gated by requireActiveSubscription so
// payslips only work with an active subscription, then by the plan's
// payroll_management flag.
const employeesOnly = [requireRole("employee"), requireActiveSubscription, requireModuleFeature("payroll_management")];

router.use(authUser);

router.get("/mine", employeesOnly, asyncHandler(mySalaryRecords));

export default router;
