import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { createEmployeeLimiter } from "../middleware/rateLimiter.js";
import { uploadDocs } from "../middleware/uploadDocs.js";

import {
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  resendEmployeeInvite,
  archiveReference,
  createReference,
} from "../controllers/admin/employees.controller.js";
import {
  listDepartments,
  createDepartment,
  deleteDepartment,
  listDesignations,
  createDesignation,
  deleteDesignation,
  listEmployeeDocuments,
  uploadEmployeeDocuments,
  deleteEmployeeDocument,
} from "../controllers/org/employeeMeta.controller.js";
import { listOrgUsers } from "../controllers/org/users.controller.js";
import {
  createLeaveType,
  deleteLeaveType,
  listLeaveTypes,
  listOrgLeaves,
  updateLeaveType,
} from "../controllers/leave.controller.js";
import {
  getEmployeeLeaveHistory,
  listLeaveAllocations,
  setLeaveAllocation,
} from "../controllers/org/leaveAllocation.controller.js";
import {
  listAdminUsers,
  createAdminUser,
  updateAdminUser,
  revokeAdminUser,
} from "../controllers/org/adminUsers.controller.js";
import {
  listSalaryComponents,
  createSalaryComponent,
  updateSalaryComponent,
  deleteSalaryComponent,
  toggleSalaryComponentStatus,
} from "../controllers/org/salaryComponents.controller.js";
import {
  listEmployeeSalaryHistory,
  incrementEmployeeSalary,
  updateEmployeeSalaryHistory,
  deleteEmployeeSalaryHistory,
} from "../controllers/org/salaryHistory.controller.js";
import {
  listEmployeeSalaryComponents,
  assignEmployeeSalaryComponent,
  updateEmployeeSalaryComponent,
  removeEmployeeSalaryComponent,
} from "../controllers/org/employeeSalaryComponents.controller.js";
import {
  addAllowedIp,
  getAllowedIps,
  listOrgAttendance,
  manualEntry,
  removeAllowedIp,
} from "../controllers/attendance.controller.js";
import {
  generatePayroll,
  downloadPayslip,
  exportOrgSalaryRecords,
  listOrgSalaryRecords,
  deleteSalaryPeriod,
  deleteSalaryRecord,
} from "../controllers/salary.controller.js";
import {
  orgDashboardAnalytics,
} from "../controllers/org/orgDashboardAnalytics.controller.js";

const router = Router();

// Clean 3-tier role system. Staff (org_admin + sub_admin) share all operational
// management access; destructive operations (delete/sub-admin mgmt/org settings)
// are org_admin-only. All routes are scoped to the JWT's org claim.
//
// Staff/org-admin modules are ALSO gated by requireActiveSubscription so that
// none of them work without an active org subscription.
const staff = [requireRole("org_admin", "sub_admin"), requireActiveSubscription];
const orgAdminsOnly = [requireRole("org_admin"), requireActiveSubscription];

// Per-module gates: subscription first, then the org's CURRENT ACTIVE plan's
// module_flags (live DB read on every request — no cache).
const empMgmt = [...staff, requireModuleFeature("employee_management")];
const empMgmtOwner = [...orgAdminsOnly, requireModuleFeature("employee_management")];
const userMgmtStaff = [...staff, requireModuleFeature("user_management")];
const userMgmt = [...orgAdminsOnly, requireModuleFeature("user_management")];
const attendanceMgmt = [...staff, requireModuleFeature("attendance_management")];
const attendanceMgmtOwner = [...orgAdminsOnly, requireModuleFeature("attendance_management")];
const leaveMgmt = [...staff, requireModuleFeature("leave_management")];
const leaveMgmtOwner = [...orgAdminsOnly, requireModuleFeature("leave_management")];
const payrollMgmt = [...staff, requireModuleFeature("payroll_management")];
const payrollMgmtOwner = [...orgAdminsOnly, requireModuleFeature("payroll_management")];

// ---- Employees ----
// Staff can create/edit/list/view employees and upload documents. Only the
// org_admin can DELETE.
router.get("/employees", empMgmt, asyncHandler(listEmployees));
router.post("/employees", empMgmt, createEmployeeLimiter, asyncHandler(createEmployee));
router.get("/employees/:uuid", empMgmt, asyncHandler(getEmployee));
router.put("/employees/:uuid", empMgmt, asyncHandler(updateEmployee));
router.delete("/employees/:uuid", empMgmtOwner, asyncHandler(deleteEmployee));
router.post("/employees/:uuid/resend-invite", userMgmtStaff, asyncHandler(resendEmployeeInvite));

// Reference records (ex-employees / learned_reference): create a standalone
// record directly, or archive an existing roster row into the reference list.
// /employees/reference (literal) is registered before the /employees/:uuid
// patterns as a defensive measure against "reference" being captured as a UUID.
router.post("/employees/reference", empMgmt, asyncHandler(createReference));
router.post("/employees/:uuid/archive-reference", empMgmt, asyncHandler(archiveReference));

// Employee documents
router.get("/employees/:uuid/documents", empMgmt, asyncHandler(listEmployeeDocuments));
router.post(
  "/employees/:uuid/documents",
  empMgmt,
  uploadDocs.array("documents", 10),
  asyncHandler(uploadEmployeeDocuments)
);
router.delete("/employees/documents/:docUuid", empMgmtOwner, asyncHandler(deleteEmployeeDocument));

router.get("/users", userMgmtStaff, asyncHandler(listOrgUsers));

// ---- Sub-admin management (org_admin only) ----
router.get("/admin-users", userMgmt, asyncHandler(listAdminUsers));
router.post("/admin-users", userMgmt, createEmployeeLimiter, asyncHandler(createAdminUser));
router.patch("/admin-users/:uuid", userMgmt, asyncHandler(updateAdminUser));
router.post("/admin-users/:uuid/revoke", userMgmt, asyncHandler(revokeAdminUser));

// ---- Managed departments & designations (staff; delete = org_admin) ----
router.get("/departments", staff, asyncHandler(listDepartments));
router.post("/departments", staff, asyncHandler(createDepartment));
router.delete("/departments/:uuid", orgAdminsOnly, asyncHandler(deleteDepartment));

router.get("/designations", staff, asyncHandler(listDesignations));
router.post("/designations", staff, asyncHandler(createDesignation));
router.delete("/designations/:uuid", orgAdminsOnly, asyncHandler(deleteDesignation));

// ---- Leave types + leave review (staff; delete type = org_admin) ----
router.get("/leave-types", leaveMgmt, asyncHandler(listLeaveTypes));
router.post("/leave-types", leaveMgmt, asyncHandler(createLeaveType));
router.put("/leave-types/:id", leaveMgmt, asyncHandler(updateLeaveType));
router.delete("/leave-types/:id", leaveMgmtOwner, asyncHandler(deleteLeaveType));

router.get("/leaves", leaveMgmt, asyncHandler(listOrgLeaves));

// ---- Leave allocations (staff: allocate/edit balances; history = staff) ----
router.get("/leave-allocations", leaveMgmt, asyncHandler(listLeaveAllocations));
router.put("/leave-allocations", leaveMgmt, asyncHandler(setLeaveAllocation));
router.get("/employees/:uuid/leave-allocations", leaveMgmt, asyncHandler(getEmployeeLeaveHistory));

// ---- Attendance (staff: view, add/edit IPs, manual entries; delete IP = org_admin) ----
router.get("/attendance", attendanceMgmt, asyncHandler(listOrgAttendance));
router.get("/attendance/ips", attendanceMgmt, asyncHandler(getAllowedIps));
router.post("/attendance/ips", attendanceMgmt, asyncHandler(addAllowedIp));
router.delete("/attendance/ips/:id", attendanceMgmtOwner, asyncHandler(removeAllowedIp));
router.post("/attendance/manual-entry", attendanceMgmt, asyncHandler(manualEntry));

// ---- Salary records / payroll ledger (staff view+export+build; delete period = org_admin) ----
router.get("/salary-records", payrollMgmt, asyncHandler(listOrgSalaryRecords));
router.get("/salary-records/export", payrollMgmt, asyncHandler(exportOrgSalaryRecords));
router.get("/salary-records/:uuid/payslip", payrollMgmt, asyncHandler(downloadPayslip));
router.delete("/salary-records/:uuid", payrollMgmtOwner, asyncHandler(deleteSalaryRecord));
router.delete("/salary-records/period/:year/:month", payrollMgmtOwner, asyncHandler(deleteSalaryPeriod));

// ---- Salary components â€” unified allowances/deductions (staff; delete + status toggle = org_admin) ----
router.get("/salary-components", payrollMgmt, asyncHandler(listSalaryComponents));
router.post("/salary-components", payrollMgmt, asyncHandler(createSalaryComponent));
router.put("/salary-components/:uuid", payrollMgmt, asyncHandler(updateSalaryComponent));
router.delete("/salary-components/:uuid", payrollMgmtOwner, asyncHandler(deleteSalaryComponent));
router.patch("/salary-components/:uuid/status", payrollMgmtOwner, asyncHandler(toggleSalaryComponentStatus));

// ---- Employee salary history + salary increment (staff) ----
router.get("/employees/:uuid/salary-history", payrollMgmt, asyncHandler(listEmployeeSalaryHistory));
router.post("/employees/:uuid/increment-salary", payrollMgmt, asyncHandler(incrementEmployeeSalary));
router.put("/employees/:uuid/salary-history/:historyUuid", payrollMgmtOwner, asyncHandler(updateEmployeeSalaryHistory));
router.delete("/employees/:uuid/salary-history/:historyUuid", payrollMgmtOwner, asyncHandler(deleteEmployeeSalaryHistory));

// ---- Per-employee salary component assignments (staff) ----
router.get("/employees/:uuid/salary-components", payrollMgmt, asyncHandler(listEmployeeSalaryComponents));
router.post("/employees/:uuid/salary-components", payrollMgmt, asyncHandler(assignEmployeeSalaryComponent));
router.put("/employees/:uuid/salary-components/:assignUuid", payrollMgmt, asyncHandler(updateEmployeeSalaryComponent));
router.delete("/employees/:uuid/salary-components/:assignUuid", payrollMgmt, asyncHandler(removeEmployeeSalaryComponent));

// ---- Payroll auto-generation (staff) ----
router.post("/payroll/generate", payrollMgmt, asyncHandler(generatePayroll));

// ---- Org dashboard analytics (staff) ----
router.get("/dashboard/analytics", staff, asyncHandler(orgDashboardAnalytics));

export default router;


