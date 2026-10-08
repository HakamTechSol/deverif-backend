import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import { createEmployeeLimiter } from "../middleware/rateLimiter.js";
import { uploadDocs } from "../middleware/uploadDocs.js";
import { uploadAttachments } from "../middleware/uploadAttachments.js";

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
  listExpenseCategories,
  createExpenseCategory,
  listExpenseClaims,
  getExpenseClaim,
  submitExpenseClaim,
  reviewExpenseClaim,
  payExpenseClaim,
  bulkPayExpenseClaims,
  uploadExpenseReceipts,
  removeExpenseReceipt,
  downloadExpenseReceipt,
} from "../controllers/org/expenses.controller.js";
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
  cancelAdminUserInvite,
  removeAdminUserPermanently,
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
  previewPayroll,
  downloadPayslip,
  exportOrgSalaryRecords,
  listOrgSalaryRecords,
  deleteSalaryPeriod,
  deleteSalaryRecord,
} from "../controllers/salary.controller.js";
import {
  listOvertimeRequests,
  createOvertimeRequest,
  decideOvertimeRequest,
} from "../controllers/org/overtime.controller.js";
import {
  listExitRequests,
  listExitChecklistPending,
  getExitRequestDetail,
  submitExitRequest,
  reviewExitRequest,
  clearExitChecklistItem,
  listExitAssets,
  previewSettlement,
  draftSettlement,
  advanceSettlement,
  completeExitRequest,
} from "../controllers/org/offboarding.controller.js";
import {
  orgDashboardAnalytics,
} from "../controllers/org/orgDashboardAnalytics.controller.js";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  previewTemplate,
  listLetters,
  getLetter,
  createLetter,
  issueLetter,
  revokeLetter,
  revertLetter,
  deleteLetter,
  downloadLetterPdf,
} from "../controllers/org/hrLetters.controller.js";

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

// HR Letters. Staff manage letters; deleting a template is org-admin-only
// because it is a shared org-wide resource every issued letter was rendered from.
const hrLettersMgmt = [...staff, requireModuleFeature("hr_letters_management")];
const hrLettersOwner = [...orgAdminsOnly, requireModuleFeature("hr_letters_management")];

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
// Pending-invite lifecycle, mirroring /admin/users/:uuid/cancel-invite. Both are
// org-scoped inside the controller via loadSubAdminInScope(req.scopeOrgId), and
// both refuse once the invite has been accepted.
router.delete(
  "/admin-users/:uuid/cancel-invite",
  userMgmt,
  asyncHandler(cancelAdminUserInvite)
);
router.delete("/admin-users/:uuid", userMgmt, asyncHandler(removeAdminUserPermanently));

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

// ---- Salary components —” unified allowances/deductions (staff; delete + status toggle = org_admin) ----
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
// Preview is registered before generate and, more importantly, is POST because it
// carries month/year/selection in the body. It writes NOTHING - no record, no
// line, no audit entry - so it is safe to call as often as anyone likes while
// deciding. It runs the identical computation the generate path runs, so the
// number previewed and the number committed cannot diverge.
router.post("/payroll/preview", payrollMgmt, asyncHandler(previewPayroll));
router.post("/payroll/generate", payrollMgmt, asyncHandler(generatePayroll));

// ---- Overtime requests (staff) ----
// The input payroll's overtime addition reads. Registered here rather than on
// the attendance routes because overtime is a pay decision with an approval, not
// a clock event: attendance records that someone was present, this records that
// the extra hours were authorised.
router.get("/overtime-requests", payrollMgmt, asyncHandler(listOvertimeRequests));
router.post("/overtime-requests", payrollMgmt, asyncHandler(createOvertimeRequest));
router.post("/overtime-requests/:uuid/decide", payrollMgmt, asyncHandler(decideOvertimeRequest));

// ---- Offboarding / exit management (staff) ----
// Gated on separation_management, which already exists as a module flag; no new
// entitlement was introduced for this.
//
// Ordering note: the literal "/offboarding/clearances" path is registered before
// the "/offboarding/:uuid" pattern so "clearances" cannot be read as a uuid.
// Same defensive pattern used for "/employees/reference" and "/hr-letters".
const separationMgmt = [...staff, requireModuleFeature("separation_management")];

router.get("/offboarding/clearances", separationMgmt, asyncHandler(listExitChecklistPending));
router.get("/offboarding/exit-requests", separationMgmt, asyncHandler(listExitRequests));
router.post("/offboarding/exit-requests", separationMgmt, asyncHandler(submitExitRequest));
router.get("/offboarding/exit-requests/:uuid", separationMgmt, asyncHandler(getExitRequestDetail));
router.post("/offboarding/exit-requests/:uuid/review", separationMgmt, asyncHandler(reviewExitRequest));
router.post(
  "/offboarding/exit-requests/:uuid/checklist/:checklistUuid",
  separationMgmt,
  asyncHandler(clearExitChecklistItem),
);
router.get("/offboarding/exit-requests/:uuid/assets", separationMgmt, asyncHandler(listExitAssets));
router.get("/offboarding/exit-requests/:uuid/settlement", separationMgmt, asyncHandler(previewSettlement));
router.post("/offboarding/exit-requests/:uuid/settlement", separationMgmt, asyncHandler(draftSettlement));
router.post(
  "/offboarding/exit-requests/:uuid/settlement/advance",
  separationMgmt,
  asyncHandler(advanceSettlement),
);
router.post("/offboarding/exit-requests/:uuid/complete", separationMgmt, asyncHandler(completeExitRequest));

// ---- HR Letters ----
// Ordering note: the literal "/letter-templates" and "/hr-letters/preview" paths
// are registered BEFORE the "/:uuid" patterns so they cannot be swallowed by the
// uuid matcher. Same defensive pattern used for "/employees/reference".
router.get("/letter-templates", hrLettersMgmt, asyncHandler(listTemplates));
router.post("/letter-templates", hrLettersMgmt, asyncHandler(createTemplate));
router.get("/letter-templates/:uuid", hrLettersMgmt, asyncHandler(getTemplate));
router.put("/letter-templates/:uuid", hrLettersMgmt, asyncHandler(updateTemplate));
router.delete("/letter-templates/:uuid", hrLettersOwner, asyncHandler(deleteTemplate));

router.post("/letter-templates/:uuid/preview", hrLettersMgmt, asyncHandler(previewTemplate));

router.get("/hr-letters", hrLettersMgmt, asyncHandler(listLetters));
router.post("/hr-letters", hrLettersMgmt, asyncHandler(createLetter));
router.get("/hr-letters/:uuid", hrLettersMgmt, asyncHandler(getLetter));
router.post("/hr-letters/:uuid/issue", hrLettersMgmt, asyncHandler(issueLetter));
router.post("/hr-letters/:uuid/revoke", hrLettersMgmt, asyncHandler(revokeLetter));
router.post("/hr-letters/:uuid/re-draft", hrLettersMgmt, asyncHandler(revertLetter));
router.delete("/hr-letters/:uuid", hrLettersMgmt, asyncHandler(deleteLetter));
router.get("/hr-letters/:uuid/pdf", hrLettersMgmt, asyncHandler(downloadLetterPdf));

// ---- Assets ----
// Gated on asset_management, which the plan flags already carry.
//
// Reading the category list is NOT administration, and it has to be available to
// sub-admins: the asset form's category field is `required`, so a sub-admin who
// cannot list categories cannot create or edit an asset at all, and the page
// fails by rendering an empty dropdown against a 403 it never shows. Only
// redefining what classes of asset exist is org_admin-only, because that changes
// what the register reports on. So the GET joins the staff-level gate and only
// the writes stay behind orgAdminsOnly.
const assetMgmt = [...staff, requireModuleFeature("asset_management")];
// Aliased: expense and asset categories are separate tables with separate
// lifecycles, and both modules export a listCategories/createCategory pair. Same
// name, different register - importing both unaliased would silently shadow one.
const expenseCategoryMgmt = [...staff, requireModuleFeature("expense_management")];
const assetCategoryMgmt = [...orgAdminsOnly, requireModuleFeature("asset_management")];

router.get("/asset-categories", assetMgmt, asyncHandler(listCategories));
router.post("/asset-categories", assetCategoryMgmt, asyncHandler(createCategory));
router.put("/asset-categories/:uuid", assetCategoryMgmt, asyncHandler(updateCategory));
router.delete("/asset-categories/:uuid", assetCategoryMgmt, asyncHandler(deleteCategory));

router.get("/assets", assetMgmt, asyncHandler(listAssets));
router.post("/assets", assetMgmt, asyncHandler(createAsset));
// Summary before /assets/:uuid so "summary" is not read as a uuid.
router.get("/assets/summary", assetMgmt, asyncHandler(summary));
router.get("/assets/:uuid", assetMgmt, asyncHandler(getAsset));
router.put("/assets/:uuid", assetMgmt, asyncHandler(updateAsset));
router.post("/assets/:uuid/assign", assetMgmt, asyncHandler(assignAsset));
router.post("/assets/:uuid/return", assetMgmt, asyncHandler(returnAsset));
router.post("/assets/:uuid/maintenance", assetMgmt, asyncHandler(reportMaintenance));
router.post("/assets/:uuid/retire", assetMgmt, asyncHandler(retireAsset));
router.post("/assets/:uuid/reinstate", assetMgmt, asyncHandler(reinstateAsset));
router.get("/asset-maintenance", assetMgmt, asyncHandler(listMaintenance));
router.post("/asset-maintenance/:jobUuid/complete", assetMgmt, asyncHandler(completeMaintenance));
// Files go through the polymorphic attachments table, never a path column. See
// 20261103_create_attachments.sql: a module keeps its own row and never grows a
// file column, because attachments is what supplies tenant scoping, the
// path-traversal guard, soft delete and the audit entry.
router.get("/assets/:uuid/receipts", assetMgmt, asyncHandler(listReceipts));
router.post(
  "/assets/:uuid/receipts",
  assetMgmt,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadReceipts),
);
router.get("/asset-maintenance/:jobUuid/invoices", assetMgmt, asyncHandler(listInvoices));
router.post(
  "/asset-maintenance/:jobUuid/invoices",
  assetMgmt,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadInvoices),
);
router.delete("/asset-attachments/:attachmentUuid", assetMgmt, asyncHandler(removeAttachment));
router.get("/asset-attachments/:attachmentUuid/download", assetMgmt, asyncHandler(downloadAttachment));

// ---- Expense claims (staff) ----
// Reuses the same attachments middleware and the shared `attachments` table via
// entity_type='expense_claim'; no file column lives on expense_claims itself.
router.get("/expense-categories", expenseCategoryMgmt, asyncHandler(listExpenseCategories));
router.post("/expense-categories", expenseCategoryMgmt, asyncHandler(createExpenseCategory));
router.get("/expense-claims", expenseCategoryMgmt, asyncHandler(listExpenseClaims));
router.get("/expense-claims/:uuid", expenseCategoryMgmt, asyncHandler(getExpenseClaim));
router.post("/expense-claims", expenseCategoryMgmt, asyncHandler(submitExpenseClaim));
// Registered BEFORE the /:uuid routes deliberately. Express matches in
// registration order, so a literal segment sitting behind a parameter is one
// refactor away from being swallowed by it. `/bulk-pay` as a uuid string would
// reach loadClaim and 404 with a confusing message instead of paying anything.
router.post("/expense-claims/bulk-pay", expenseCategoryMgmt, asyncHandler(bulkPayExpenseClaims));
router.post("/expense-claims/:uuid/review", expenseCategoryMgmt, asyncHandler(reviewExpenseClaim));
router.post("/expense-claims/:uuid/pay", expenseCategoryMgmt, asyncHandler(payExpenseClaim));
router.post(
  "/expense-claims/:uuid/receipts",
  expenseCategoryMgmt,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadExpenseReceipts),
);
router.delete(
  "/expense-attachments/:attachmentUuid",
  expenseCategoryMgmt,
  asyncHandler(removeExpenseReceipt),
);
router.get(
  "/expense-attachments/:attachmentUuid/download",
  expenseCategoryMgmt,
  asyncHandler(downloadExpenseReceipt),
);

// ---- Org dashboard analytics (staff) ----
router.get("/dashboard/analytics", staff, asyncHandler(orgDashboardAnalytics));

import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  uploadReceipts,
  listReceipts,
  uploadInvoices,
  listInvoices,
  removeAttachment,
  downloadAttachment,
  listAssets,
  createAsset,
  getAsset,
  updateAsset,
  summary,
  assignAsset,
  returnAsset,
  listMaintenance,
  reportMaintenance,
  completeMaintenance,
  retireAsset,
  reinstateAsset,
} from "../controllers/org/assets.controller.js";

export default router;


