import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import { createEmployeeLimiter } from "../middleware/rateLimiter.js";
import { uploadDocs } from "../middleware/uploadDocs.js";

import {
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  deleteEmployee,
  resendEmployeeInvite,
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

// ---- Employees ----
// Staff can create/edit/list/view employees and upload documents. Only the
// org_admin can DELETE.
router.get("/employees", staff, asyncHandler(listEmployees));
router.post("/employees", staff, createEmployeeLimiter, asyncHandler(createEmployee));
router.get("/employees/:uuid", staff, asyncHandler(getEmployee));
router.put("/employees/:uuid", staff, asyncHandler(updateEmployee));
router.delete("/employees/:uuid", orgAdminsOnly, asyncHandler(deleteEmployee));
router.post("/employees/:uuid/resend-invite", staff, asyncHandler(resendEmployeeInvite));

// Employee documents
router.get("/employees/:uuid/documents", staff, asyncHandler(listEmployeeDocuments));
router.post(
  "/employees/:uuid/documents",
  staff,
  uploadDocs.array("documents", 10),
  asyncHandler(uploadEmployeeDocuments)
);
router.delete("/employees/documents/:docUuid", orgAdminsOnly, asyncHandler(deleteEmployeeDocument));

router.get("/users", staff, asyncHandler(listOrgUsers));

// ---- Sub-admin management (org_admin only) ----
router.get("/admin-users", orgAdminsOnly, asyncHandler(listAdminUsers));
router.post("/admin-users", orgAdminsOnly, createEmployeeLimiter, asyncHandler(createAdminUser));
router.patch("/admin-users/:uuid", orgAdminsOnly, asyncHandler(updateAdminUser));
router.post("/admin-users/:uuid/revoke", orgAdminsOnly, asyncHandler(revokeAdminUser));

// ---- Managed departments & designations (staff; delete = org_admin) ----
router.get("/departments", staff, asyncHandler(listDepartments));
router.post("/departments", staff, asyncHandler(createDepartment));
router.delete("/departments/:uuid", orgAdminsOnly, asyncHandler(deleteDepartment));

router.get("/designations", staff, asyncHandler(listDesignations));
router.post("/designations", staff, asyncHandler(createDesignation));
router.delete("/designations/:uuid", orgAdminsOnly, asyncHandler(deleteDesignation));

// ---- Leave types + leave review (staff; delete type = org_admin) ----
router.get("/leave-types", staff, asyncHandler(listLeaveTypes));
router.post("/leave-types", staff, asyncHandler(createLeaveType));
router.put("/leave-types/:id", staff, asyncHandler(updateLeaveType));
router.delete("/leave-types/:id", orgAdminsOnly, asyncHandler(deleteLeaveType));

router.get("/leaves", staff, asyncHandler(listOrgLeaves));

// ---- Leave allocations (staff: allocate/edit balances; history = staff) ----
router.get("/leave-allocations", staff, asyncHandler(listLeaveAllocations));
router.put("/leave-allocations", staff, asyncHandler(setLeaveAllocation));
router.get("/employees/:uuid/leave-allocations", staff, asyncHandler(getEmployeeLeaveHistory));

// ---- Attendance (staff: view, add/edit IPs, manual entries; delete IP = org_admin) ----
router.get("/attendance", staff, asyncHandler(listOrgAttendance));
router.get("/attendance/ips", staff, asyncHandler(getAllowedIps));
router.post("/attendance/ips", staff, asyncHandler(addAllowedIp));
router.delete("/attendance/ips/:id", orgAdminsOnly, asyncHandler(removeAllowedIp));
router.post("/attendance/manual-entry", staff, asyncHandler(manualEntry));

// ---- Salary records / payroll ledger (staff view+export+build; delete period = org_admin) ----
router.get("/salary-records", staff, asyncHandler(listOrgSalaryRecords));
router.get("/salary-records/export", staff, asyncHandler(exportOrgSalaryRecords));
router.get("/salary-records/:uuid/payslip", staff, asyncHandler(downloadPayslip));
router.delete("/salary-records/:uuid", orgAdminsOnly, asyncHandler(deleteSalaryRecord));
router.delete("/salary-records/period/:year/:month", orgAdminsOnly, asyncHandler(deleteSalaryPeriod));

// ---- Salary components â€” unified allowances/deductions (staff; delete + status toggle = org_admin) ----
router.get("/salary-components", staff, asyncHandler(listSalaryComponents));
router.post("/salary-components", staff, asyncHandler(createSalaryComponent));
router.put("/salary-components/:uuid", staff, asyncHandler(updateSalaryComponent));
router.delete("/salary-components/:uuid", orgAdminsOnly, asyncHandler(deleteSalaryComponent));
router.patch("/salary-components/:uuid/status", orgAdminsOnly, asyncHandler(toggleSalaryComponentStatus));

// ---- Employee salary history + salary increment (staff) ----
router.get("/employees/:uuid/salary-history", staff, asyncHandler(listEmployeeSalaryHistory));
router.post("/employees/:uuid/increment-salary", staff, asyncHandler(incrementEmployeeSalary));
router.put("/employees/:uuid/salary-history/:historyUuid", orgAdminsOnly, asyncHandler(updateEmployeeSalaryHistory));
router.delete("/employees/:uuid/salary-history/:historyUuid", orgAdminsOnly, asyncHandler(deleteEmployeeSalaryHistory));

// ---- Per-employee salary component assignments (staff) ----
router.get("/employees/:uuid/salary-components", staff, asyncHandler(listEmployeeSalaryComponents));
router.post("/employees/:uuid/salary-components", staff, asyncHandler(assignEmployeeSalaryComponent));
router.put("/employees/:uuid/salary-components/:assignUuid", staff, asyncHandler(updateEmployeeSalaryComponent));
router.delete("/employees/:uuid/salary-components/:assignUuid", staff, asyncHandler(removeEmployeeSalaryComponent));

// ---- Payroll auto-generation (staff) ----
router.post("/payroll/generate", staff, asyncHandler(generatePayroll));

// ---- Org dashboard analytics (staff) ----
router.get("/dashboard/analytics", staff, asyncHandler(orgDashboardAnalytics));

export default router;


