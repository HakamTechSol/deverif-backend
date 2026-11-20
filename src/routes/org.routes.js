import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import requireActiveSubscription from "../middleware/requireActiveSubscription.js";
import requireModuleFeature from "../middleware/requireModuleFeature.js";
import requirePermission from "../middleware/requirePermission.js";
import ApiError from "../utils/ApiError.js";
import { getDataScope, assertEmployeeInDataScope, assertCreatedRecordInDataScope } from "../utils/dataScopes.js";
import { createEmployeeLimiter } from "../middleware/rateLimiter.js";
import { uploadDocs } from "../middleware/uploadDocs.js";
import { uploadAttachments } from "../middleware/uploadAttachments.js";

import {
  createEmployee,
  listEmployees,
  getEmployee,
  updateEmployee,
  // deleteEmployee intentionally not routed: employee records are archived, never hard-deleted.
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
  listLeaveEmployees,
  listOrgLeaves,
  updateLeaveType,
} from "../controllers/leave.controller.js";
import {
  listExpenseClaims,
  getExpenseClaim,
  reviewExpenseClaim,
  payExpenseClaim,
  bulkPayExpenseClaims,
  uploadExpenseReceipts,
  removeExpenseReceipt,
  downloadExpenseReceipt,
} from "../controllers/org/expenses.controller.js";
import {
  listJobOpenings,
  createJobOpening,
  getJobOpening,
  updateJobOpening,
  listCandidates,
  getCandidate,
  createApplication,
  updateCandidate,
  moveApplicationStage,
  startOfferApplication,
  hireOffer,
  getPipeline,
  listInterviews,
  listInterviewers,
  listMyInterviews,
  scheduleInterview,
  recordInterviewFeedback,
  listOffers,
  getOfferPreparation,
  previewOffer,
  sendOffer,
  downloadOfferPdf,
  uploadResume,
  removeResume,
  downloadResume,
  parseResume,
} from "../controllers/org/recruitment.controller.js";
import {
  getEmployeeLeaveHistory,
  listLeaveAllocations,
  setLeaveAllocation,
  setDesignationLeaveAllocation,
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
  listMonthlySalaryVariables,
  createMonthlySalaryVariable,
  updateMonthlySalaryVariable,
  deleteMonthlySalaryVariable,
} from "../controllers/org/monthlySalaryVariables.controller.js";
import {
  addAllowedIp,
  correctAttendance,
  getAllowedIps,
  listMissingAttendance,
  listOrgAttendance,
  manualEntry,
  manualMissingEntry,
  removeAllowedIp,
} from "../controllers/attendance.controller.js";
import {
  generatePayroll,
  previewPayroll,
  listPayrollEmployees,
  getPayrollSettings,
  updatePayrollSettings,
  getMonthlyWorkSchedule,
  saveMonthlyWorkSchedule,
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
  listExitClearanceTemplates,
  createExitClearanceTemplate,
  updateExitClearanceTemplate,
  deleteExitClearanceTemplate,
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
  previewTemplatePdf,
  previewTemplate,
  listLetters,
  getLetter,
  createLetter,
  updateLetter,
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
const requireEntireModuleScope = (moduleKey) => (req, res, next) => {
  if (getDataScope(req.user, moduleKey) !== "entire_organization") {
    return next(new ApiError(403, `${moduleKey} settings require Entire Organization data scope.`));
  }
  return next();
};
const employeeOrgWideScope = requireEntireModuleScope("employees");
const attendanceOrgWideScope = requireEntireModuleScope("attendance");
const leaveOrgWideScope = requireEntireModuleScope("leave_management");
const hrLettersOrgWideScope = requireEntireModuleScope("hr_letters");
const offboardingOrgWideScope = requireEntireModuleScope("offboarding");

const employeeView = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.view")];
const employeeCreate = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.create")];
const employeeEdit = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.edit")];
const employeeArchive = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.archive")];
const departmentManage = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.manage_departments")];
const designationManage = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.manage_designations")];
const attendanceView = [...staff, requireModuleFeature("attendance_management"), requirePermission("attendance.view")];
const attendanceManual = [...staff, requireModuleFeature("attendance_management"), requirePermission("attendance.manual_entry")];
const attendanceCorrect = [...staff, requireModuleFeature("attendance_management"), requirePermission("attendance.correct_check_in_out")];
const attendanceIps = [...staff, requireModuleFeature("attendance_management"), requirePermission("attendance.manage_ips"), attendanceOrgWideScope];
const leaveView = [...staff, requireModuleFeature("leave_management"), requirePermission("leave_management.view")];
const leaveAllocate = [...staff, requireModuleFeature("leave_management"), requirePermission("leave_management.allocate_balance")];
const leaveTypesManage = [...staff, requireModuleFeature("leave_management"), requirePermission("leave_management.manage_leave_types"), leaveOrgWideScope];
const payrollView = [...staff, requireModuleFeature("payroll_management"), requirePermission("payroll.view")];
const payrollGenerateAccess = [...staff, requireModuleFeature("payroll_management"), requirePermission("payroll.generate")];
const payrollSettingsAccess = [...staff, requireModuleFeature("payroll_management"), requirePermission("payroll.manage_settings")];
const payrollEmployeeComponentsAccess = [...staff, requireModuleFeature("payroll_management"), requirePermission("payroll.manage_employee_components")];
const payrollSalaryAccess = [...staff, requireModuleFeature("payroll_management"), requirePermission("payroll.adjust_salary")];
const employeeDataScope = (moduleKey) => async (req, res, next) => {
  try {
    await assertEmployeeInDataScope(req, moduleKey, req.params.uuid);
    next();
  } catch (error) {
    next(error);
  }
};
const payrollEmployeeScope = employeeDataScope("payroll");
const requireOrganizationWideReportsScope = (req, res, next) => {
  if (getDataScope(req.user, "reports") !== "entire_organization") {
    return next(new ApiError(403, "Organization-wide analytics require Entire Organization data scope."));
  }
  return next();
};
const requireOrganizationSettingsScope = (req, res, next) => {
  if (getDataScope(req.user, "organization_settings") !== "entire_organization") {
    return next(new ApiError(403, "Organization settings require Entire Organization data scope."));
  }
  return next();
};
const userMgmtFeature = requireModuleFeature("user_management");
const userMgmtPermission = requirePermission("user_management");
const portalAccessIfRequested = (req, res, next) => {
  if (req.body?.send_invite !== true) return next();
  return userMgmtFeature(req, res, (error) => error ? next(error) : userMgmtPermission(req, res, next));
};

// HR Letters. Staff manage letters; deleting a template is org-admin-only
// because it is a shared org-wide resource every issued letter was rendered from.
const hrLetterView = [...staff, requireModuleFeature("hr_letters_management"), requirePermission("hr_letters.view")];
const hrLetterCreate = [...staff, requireModuleFeature("hr_letters_management"), requirePermission("hr_letters.create_draft")];
const hrLetterEdit = [...staff, requireModuleFeature("hr_letters_management"), requirePermission("hr_letters.edit_draft")];
const hrLetterIssue = [...staff, requireModuleFeature("hr_letters_management"), requirePermission("hr_letters.issue")];
const hrLetterRevoke = [...staff, requireModuleFeature("hr_letters_management"), requirePermission("hr_letters.revoke")];
const hrLetterTemplates = [...staff, requireModuleFeature("hr_letters_management"), requirePermission("hr_letters.manage_templates")];
const hrLettersOwner = [...orgAdminsOnly, requireModuleFeature("hr_letters_management")];

// ---- Employees ----
// Staff can create/edit/list/view employees and upload documents. Only the
// org_admin can DELETE.
router.get("/employees", employeeView, asyncHandler(listEmployees));
router.post("/employees", employeeCreate, portalAccessIfRequested, createEmployeeLimiter, asyncHandler(createEmployee));
router.get("/employees/:uuid", employeeView, asyncHandler(getEmployee));
router.put("/employees/:uuid", employeeEdit, asyncHandler(updateEmployee));
router.delete("/employees/:uuid", employeeArchive, asyncHandler(archiveReference));
router.post("/employees/:uuid/resend-invite", userMgmtStaff, employeeEdit, employeeDataScope("employees"), asyncHandler(resendEmployeeInvite));

// Reference records (ex-employees / learned_reference): create a standalone
// record directly, or archive an existing roster row into the reference list.
// /employees/reference (literal) is registered before the /employees/:uuid
// patterns as a defensive measure against "reference" being captured as a UUID.
router.post("/employees/reference", employeeCreate, asyncHandler(createReference));
router.post("/employees/:uuid/archive-reference", employeeArchive, asyncHandler(archiveReference));

// Employee documents
router.get("/employees/:uuid/documents", employeeView, asyncHandler(listEmployeeDocuments));
router.post(
  "/employees/:uuid/documents",
  employeeEdit,
  uploadDocs.array("documents", 10),
  asyncHandler(uploadEmployeeDocuments)
);
router.delete("/employees/documents/:docUuid", employeeEdit, asyncHandler(deleteEmployeeDocument));

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
router.get("/departments", employeeView, asyncHandler(listDepartments));
router.post("/departments", departmentManage, asyncHandler(createDepartment));
router.delete("/departments/:uuid", departmentManage, asyncHandler(deleteDepartment));

router.get("/designations", employeeView, asyncHandler(listDesignations));
router.post("/designations", designationManage, asyncHandler(createDesignation));
router.delete("/designations/:uuid", designationManage, asyncHandler(deleteDesignation));

// ---- Leave types + leave review (staff; delete type = org_admin) ----
router.get("/leave-types", leaveView, asyncHandler(listLeaveTypes));
router.post("/leave-types", leaveTypesManage, asyncHandler(createLeaveType));
router.put("/leave-types/:id", leaveTypesManage, asyncHandler(updateLeaveType));
router.delete("/leave-types/:id", [...leaveTypesManage, requireRole("org_admin")], asyncHandler(deleteLeaveType));

router.get("/leave-employees", leaveView, asyncHandler(listLeaveEmployees));
router.get("/leaves", leaveView, asyncHandler(listOrgLeaves));

// ---- Leave allocations (staff: allocate/edit balances; history = staff) ----
router.get("/leave-allocations", leaveAllocate, asyncHandler(listLeaveAllocations));
router.put("/leave-allocations", leaveAllocate, asyncHandler(setLeaveAllocation));
router.put("/leave-allocations/designation", [...leaveAllocate, leaveOrgWideScope], asyncHandler(setDesignationLeaveAllocation));
router.get("/employees/:uuid/leave-allocations", leaveAllocate, asyncHandler(getEmployeeLeaveHistory));

// ---- Attendance (staff: view, add/edit IPs, manual entries; delete IP = org_admin) ----
router.get("/attendance", attendanceView, asyncHandler(listOrgAttendance));
router.get("/attendance/missing", attendanceManual, asyncHandler(listMissingAttendance));
router.get("/attendance/ips", attendanceIps, asyncHandler(getAllowedIps));
router.post("/attendance/ips", attendanceIps, asyncHandler(addAllowedIp));
router.delete("/attendance/ips/:id", attendanceIps, asyncHandler(removeAllowedIp));
router.post("/attendance/manual-entry", attendanceManual, asyncHandler(manualEntry));
router.post("/attendance/missing/manual-entry", attendanceManual, asyncHandler(manualMissingEntry));
router.patch("/attendance/:uuid/correction", attendanceCorrect, asyncHandler(correctAttendance));

// ---- Payroll settings and monthly work calendar ----
router.get("/payroll-employees", payrollView, asyncHandler(listPayrollEmployees));
router.get("/payroll-settings", payrollView, asyncHandler(getPayrollSettings));
router.put("/payroll-settings", payrollSettingsAccess, asyncHandler(updatePayrollSettings));
router.get("/payroll-schedule", payrollView, asyncHandler(getMonthlyWorkSchedule));
router.put("/payroll-schedule", payrollSettingsAccess, asyncHandler(saveMonthlyWorkSchedule));

// ---- Salary records / payroll ledger (staff view+export+build; delete period = org_admin) ----
router.get("/salary-records", payrollView, asyncHandler(listOrgSalaryRecords));
router.get("/salary-records/export", [...payrollView, requirePermission("reports.export")], asyncHandler(exportOrgSalaryRecords));
router.get("/salary-records/:uuid/payslip", payrollView, asyncHandler(downloadPayslip));
router.delete("/salary-records/:uuid", payrollMgmtOwner, asyncHandler(deleteSalaryRecord));
router.delete("/salary-records/period/:year/:month", payrollMgmtOwner, asyncHandler(deleteSalaryPeriod));

// ---- Salary components —” unified allowances/deductions (staff; delete + status toggle = org_admin) ----
router.get("/salary-components", payrollView, asyncHandler(listSalaryComponents));
router.post("/salary-components", payrollSettingsAccess, asyncHandler(createSalaryComponent));
router.put("/salary-components/:uuid", payrollSettingsAccess, asyncHandler(updateSalaryComponent));
router.delete("/salary-components/:uuid", payrollMgmtOwner, asyncHandler(deleteSalaryComponent));
router.patch("/salary-components/:uuid/status", payrollSettingsAccess, asyncHandler(toggleSalaryComponentStatus));

// ---- Employee salary history + salary increment (staff) ----
router.get("/employees/:uuid/salary-history", payrollView, payrollEmployeeScope, asyncHandler(listEmployeeSalaryHistory));
router.post("/employees/:uuid/increment-salary", payrollSalaryAccess, payrollEmployeeScope, asyncHandler(incrementEmployeeSalary));
router.put("/employees/:uuid/salary-history/:historyUuid", payrollMgmtOwner, payrollEmployeeScope, asyncHandler(updateEmployeeSalaryHistory));
router.delete("/employees/:uuid/salary-history/:historyUuid", payrollMgmtOwner, payrollEmployeeScope, asyncHandler(deleteEmployeeSalaryHistory));

// ---- Per-employee salary component assignments (staff) ----
router.get("/employees/:uuid/salary-components", payrollView, payrollEmployeeScope, asyncHandler(listEmployeeSalaryComponents));
router.post("/employees/:uuid/salary-components", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(assignEmployeeSalaryComponent));
router.put("/employees/:uuid/salary-components/:assignUuid", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(updateEmployeeSalaryComponent));
router.delete("/employees/:uuid/salary-components/:assignUuid", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(removeEmployeeSalaryComponent));
router.get("/employees/:uuid/monthly-salary-variables", payrollView, payrollEmployeeScope, asyncHandler(listMonthlySalaryVariables));
router.post("/employees/:uuid/monthly-salary-variables", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(createMonthlySalaryVariable));
router.put("/employees/:uuid/monthly-salary-variables/:variableUuid", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(updateMonthlySalaryVariable));
router.delete("/employees/:uuid/monthly-salary-variables/:variableUuid", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(deleteMonthlySalaryVariable));

import { getApprovalPolicyHandler, updateApprovalPolicyHandler } from "../controllers/org/approvalPolicy.controller.js";

// ---- Approval policy (org_admin) ----
router.get("/approval-policy", [...staff, requirePermission("organization_settings.view"), requireOrganizationSettingsScope], asyncHandler(getApprovalPolicyHandler));
router.put("/approval-policy", [...staff, requirePermission("organization_settings.edit"), requireOrganizationSettingsScope], asyncHandler(updateApprovalPolicyHandler));

// ---- Payroll auto-generation (staff) ----
// Preview is registered before generate and, more importantly, is POST because it
// carries month/year/selection in the body. It writes NOTHING - no record, no
// line, no audit entry - so it is safe to call as often as anyone likes while
// deciding. It runs the identical computation the generate path runs, so the
// number previewed and the number committed cannot diverge.
router.post("/payroll/preview", payrollGenerateAccess, asyncHandler(previewPayroll));
router.post("/payroll/generate", payrollGenerateAccess, asyncHandler(generatePayroll));

// ---- Overtime requests (staff) ----
// The input payroll's overtime addition reads. Registered here rather than on
// the attendance routes because overtime is a pay decision with an approval, not
// a clock event: attendance records that someone was present, this records that
// the extra hours were authorised.
router.get("/overtime-requests", [...staff, requireModuleFeature("attendance_management"), requirePermission("attendance.view")], asyncHandler(listOvertimeRequests));
router.post("/overtime-requests", attendanceMgmtOwner, asyncHandler(createOvertimeRequest));
router.post("/overtime-requests/:uuid/decide", attendanceMgmtOwner, asyncHandler(decideOvertimeRequest));

// ---- Offboarding / exit management (staff) ----
// Gated on separation_management, which already exists as a module flag; no new
// entitlement was introduced for this.
//
// Ordering note: the literal "/offboarding/clearances" path is registered before
// the "/offboarding/:uuid" pattern so "clearances" cannot be read as a uuid.
// Same defensive pattern used for "/employees/reference" and "/hr-letters".
const offboardingView = [...staff, requireModuleFeature("separation_management"), requirePermission("offboarding.view")];
const offboardingInitiate = [...staff, requireModuleFeature("separation_management"), requirePermission("offboarding.initiate")];
const offboardingChecklist = [...staff, requireModuleFeature("separation_management"), requirePermission("offboarding.manage_checklist")];
const offboardingDraftSettlement = [...staff, requireModuleFeature("separation_management"), requirePermission("offboarding.draft_settlement")];
const offboardingApproveSettlement = [...staff, requireModuleFeature("separation_management"), requirePermission("offboarding.approve_settlement")];
const offboardingComplete = [...staff, requireModuleFeature("separation_management"), requirePermission("offboarding.complete_exit")];

router.get("/offboarding/clearance-templates", [...offboardingView, offboardingOrgWideScope], asyncHandler(listExitClearanceTemplates));
router.post("/offboarding/clearance-templates", [...staff, requireModuleFeature("separation_management"), requirePermission("manage_separation"), requireRole("org_admin")], asyncHandler(createExitClearanceTemplate));
router.put("/offboarding/clearance-templates/:uuid", [...staff, requireModuleFeature("separation_management"), requirePermission("manage_separation"), requireRole("org_admin")], asyncHandler(updateExitClearanceTemplate));
router.delete("/offboarding/clearance-templates/:uuid", [...staff, requireModuleFeature("separation_management"), requirePermission("manage_separation"), requireRole("org_admin")], asyncHandler(deleteExitClearanceTemplate));

router.get("/offboarding/clearances", offboardingView, asyncHandler(listExitChecklistPending));
router.get("/offboarding/exit-requests", offboardingView, asyncHandler(listExitRequests));
router.post("/offboarding/exit-requests", offboardingInitiate, asyncHandler(submitExitRequest));
router.get("/offboarding/exit-requests/:uuid", offboardingView, asyncHandler(getExitRequestDetail));
router.post("/offboarding/exit-requests/:uuid/review", offboardingChecklist, asyncHandler(reviewExitRequest));
router.post(
  "/offboarding/exit-requests/:uuid/checklist/:checklistUuid",
  offboardingChecklist,
  asyncHandler(clearExitChecklistItem),
);
router.get("/offboarding/exit-requests/:uuid/assets", offboardingView, asyncHandler(listExitAssets));
router.get("/offboarding/exit-requests/:uuid/settlement", offboardingView, asyncHandler(previewSettlement));
router.post("/offboarding/exit-requests/:uuid/settlement", offboardingDraftSettlement, asyncHandler(draftSettlement));
router.post(
  "/offboarding/exit-requests/:uuid/settlement/advance",
  offboardingApproveSettlement,
  asyncHandler(advanceSettlement),
);
router.post("/offboarding/exit-requests/:uuid/complete", offboardingComplete, asyncHandler(completeExitRequest));

// ---- HR Letters ----
// Ordering note: the literal "/letter-templates" and "/hr-letters/preview" paths
// are registered BEFORE the "/:uuid" patterns so they cannot be swallowed by the
// uuid matcher. Same defensive pattern used for "/employees/reference".
router.get("/letter-templates", [...hrLetterView, hrLettersOrgWideScope], asyncHandler(listTemplates));
router.post("/letter-templates", [...hrLetterTemplates, hrLettersOrgWideScope], asyncHandler(createTemplate));
router.post("/letter-templates/preview-pdf", [...hrLetterView, hrLettersOrgWideScope], asyncHandler(previewTemplatePdf));
router.get("/letter-templates/:uuid", [...hrLetterView, hrLettersOrgWideScope], asyncHandler(getTemplate));
router.put("/letter-templates/:uuid", [...hrLetterTemplates, hrLettersOrgWideScope], asyncHandler(updateTemplate));
router.delete("/letter-templates/:uuid", [...hrLetterTemplates, hrLettersOrgWideScope], asyncHandler(deleteTemplate));

router.post("/letter-templates/:uuid/preview", [...hrLetterView, hrLettersOrgWideScope], asyncHandler(previewTemplate));

router.get("/hr-letters", hrLetterView, asyncHandler(listLetters));
router.post("/hr-letters", hrLetterCreate, asyncHandler(createLetter));
router.get("/hr-letters/:uuid", hrLetterView, asyncHandler(getLetter));
router.put("/hr-letters/:uuid", hrLetterEdit, asyncHandler(updateLetter));
router.post("/hr-letters/:uuid/issue", hrLetterIssue, asyncHandler(issueLetter));
router.post("/hr-letters/:uuid/revoke", hrLetterRevoke, asyncHandler(revokeLetter));
router.post("/hr-letters/:uuid/re-draft", hrLetterEdit, asyncHandler(revertLetter));
router.delete("/hr-letters/:uuid", hrLettersOwner, asyncHandler(deleteLetter));
router.get("/hr-letters/:uuid/pdf", hrLetterView, asyncHandler(downloadLetterPdf));

// ---- Assets ----
// Gated on asset_management, which the plan flags already carry.
//
const assetView = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.view")];
const assetCreate = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.create")];
const assetEdit = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.edit")];
const assetAssign = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.assign")];
const assetReturn = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.return")];
const assetRetire = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.retire")];
const assetCategories = [...staff, requireModuleFeature("asset_management"), requirePermission("assets.manage_categories")];

// ---- Recruitment ----------------------------------------------------------
// ONE GATE FOR THE WHOLE MODULE, named once.
//
// The permission is the LAST element, after requireRole and requireActiveSubscription.
// That order is load-bearing and not a style preference: requirePermission reads
// req.user, which only exists once requireRole has populated it, and an org_admin
// must pass on the ROLE alone — so a permission check placed first would deny
// org_admins and lock them out of their own company.
//
// Declared as a single constant rather than repeated per route, because a route
// registered without it is a route the module gate does not cover, and the way that
// happens is someone adding a line and forgetting the third argument. There is one
// gate, every recruitment route uses it, and the auth-matrix test asserts each route
// individually rather than trusting that.
const recruitmentView = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.view")];
const recruitmentJobCreate = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.create_job")];
const recruitmentJobEdit = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.edit_job")];
const recruitmentCandidates = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.manage_candidates")];
const recruitmentInterview = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.schedule_interview")];
const recruitmentFeedback = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.record_feedback")];
const recruitmentOffers = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.manage_offers")];
const recruitmentHire = [...staff, requireModuleFeature("recruitment_management"), requirePermission("recruitment.hire")];
const recruitmentOpeningScope = async (req, res, next) => {
  try { await assertCreatedRecordInDataScope(req, "recruitment", "job_openings", req.params.uuid); next(); }
  catch (error) { next(error); }
};
const recruitmentCandidateScope = async (req, res, next) => {
  try { await assertCreatedRecordInDataScope(req, "recruitment", "candidates", req.params.uuid); next(); }
  catch (error) { next(error); }
};

// ---- Job openings ----
router.get("/job-openings", recruitmentView, asyncHandler(listJobOpenings));
router.post("/job-openings", recruitmentJobCreate, asyncHandler(createJobOpening));
router.get("/job-openings/:uuid", recruitmentView, recruitmentOpeningScope, asyncHandler(getJobOpening));
router.put("/job-openings/:uuid", recruitmentJobEdit, recruitmentOpeningScope, asyncHandler(updateJobOpening));

// ---- Candidates, and applications (the same rows) ----
router.get("/candidates", recruitmentView, asyncHandler(listCandidates));
router.get("/candidates/:uuid", recruitmentView, recruitmentCandidateScope, asyncHandler(getCandidate));
router.post("/candidates", recruitmentCandidates, asyncHandler(createApplication));

router.get("/applications", recruitmentView, asyncHandler(listCandidates));
router.post("/applications", recruitmentCandidates, asyncHandler(createApplication));
router.put("/candidates/:uuid", recruitmentCandidates, recruitmentCandidateScope, asyncHandler(updateCandidate));
router.get("/applications/:uuid", recruitmentView, recruitmentCandidateScope, asyncHandler(getCandidate));
router.post("/applications/:uuid/move-stage", recruitmentCandidates, recruitmentCandidateScope, asyncHandler(moveApplicationStage));
// A candidate is never hired from the pipeline. Only an accepted sent offer can
// create the employee record through the offer response endpoint.
router.post(
  "/applications/:uuid/start-offer",
  recruitmentCandidates,
  recruitmentCandidateScope,
  asyncHandler(startOfferApplication),
);

// ---- Pipeline (Kanban) ----
router.get("/pipeline", recruitmentView, asyncHandler(getPipeline));
router.get("/pipeline/:uuid", recruitmentView, asyncHandler(getPipeline));

// ---- Interviews ----
router.get("/interviewers", recruitmentView, asyncHandler(listInterviewers));
router.get("/interviews", recruitmentView, asyncHandler(listInterviews));
router.post("/interviews", recruitmentInterview, asyncHandler(scheduleInterview));
router.post("/interviews/:uuid/feedback", recruitmentFeedback, asyncHandler(recordInterviewFeedback));

// Personal assignments: feedback is still checked against the assigned interviewer
// in the service, so an employee cannot submit another person's interview.
const assignedInterviewAccess = [
  requireRole("org_admin", "sub_admin", "employee"),
  requireActiveSubscription,
  requireModuleFeature("recruitment_management"),
];
router.get("/my/interviews", assignedInterviewAccess, asyncHandler(listMyInterviews));
router.post("/my/interviews/:uuid/feedback", assignedInterviewAccess, asyncHandler(recordInterviewFeedback));

// ---- Offers ----
router.get("/offers", recruitmentView, asyncHandler(listOffers));
router.get("/offers/:uuid/prepare", recruitmentView, asyncHandler(getOfferPreparation));
router.get("/offers/:uuid/pdf", recruitmentView, asyncHandler(downloadOfferPdf));
router.post("/offers/:uuid/preview", recruitmentView, asyncHandler(previewOffer));
// ONLY the employee-create route escalates. `portal_access` is not read by the
// offer-response path any more (see respondToOffer), so keeping it on that route
// would gate a field nothing looks at — a permission check that appears to
// protect something while actually only confusing whoever reads it.
router.post("/offers/:uuid/hire", recruitmentHire, recruitmentCandidateScope, asyncHandler(hireOffer));
router.post("/offers/:uuid/send", recruitmentOffers, asyncHandler(sendOffer));

// ---- Resumes ----
// entity_type='candidate', through the shared attachments service. Distinct
// attachment routes from the other modules on purpose: the server's removeResume
// refuses any attachment whose entity_type is not a candidate, so an expense receipt
// is not reachable here.
router.post(
  "/candidates/:uuid/resume",
  recruitmentCandidates,
  recruitmentCandidateScope,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadResume),
);
router.post(
  "/resume/parse",
  recruitmentCandidates,
  uploadAttachments.single("file"),
  asyncHandler(parseResume),
);
router.delete("/candidate-attachments/:attachmentUuid", recruitmentCandidates, asyncHandler(removeResume));
router.get(
  "/candidate-attachments/:attachmentUuid/download",
  recruitmentView,
  asyncHandler(downloadResume),
);
const expenseView = [...staff, requireModuleFeature("expense_management"), requirePermission("expenses.view")];
const expenseApprove = [...staff, requireModuleFeature("expense_management"), requirePermission("expenses.approve_employee")];
const expensePay = [...staff, requireModuleFeature("expense_management"), requirePermission("expenses.process_payment")];

router.get("/assets", assetView, asyncHandler(listAssets));
router.post("/assets", assetCreate, asyncHandler(createAsset));
// Summary before /assets/:uuid so "summary" is not read as a uuid.
router.get("/assets/summary", assetView, asyncHandler(summary));
router.get("/assets/:uuid", assetView, asyncHandler(getAsset));
router.put("/assets/:uuid", assetEdit, asyncHandler(updateAsset));
router.post("/assets/:uuid/assign", assetAssign, asyncHandler(assignAsset));
router.post("/assets/:uuid/return", assetReturn, asyncHandler(returnAsset));
router.post("/assets/:uuid/retire", assetRetire, asyncHandler(retireAsset));
router.post("/assets/:uuid/reinstate", assetRetire, asyncHandler(reinstateAsset));
// Files go through the polymorphic attachments table, never a path column. See
// 20261103_create_attachments.sql: a module keeps its own row and never grows a
// file column, because attachments is what supplies tenant scoping, the
// path-traversal guard, soft delete and the audit entry.
router.get("/assets/:uuid/receipts", assetView, asyncHandler(listReceipts));
router.post(
  "/assets/:uuid/receipts",
  assetEdit,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadReceipts),
);
router.delete("/asset-attachments/:attachmentUuid", assetEdit, asyncHandler(removeAttachment));
router.get("/asset-attachments/:attachmentUuid/download", assetView, asyncHandler(downloadAttachment));

// ---- Expense claims (staff) ----
// Reuses the same attachments middleware and the shared `attachments` table via
// entity_type='expense_claim'; no file column lives on expense_claims itself.
//
// NO POST /expense-claims. There is deliberately no route here that creates a
// claim, because an org admin filing their own claim is a claim that approves
// itself: this same gate is what lets them approve one (requirePermission
// "approve_expenses" is always true for org_admin), so a creation route would
// hand the one person who can rubber-stamp a reimbursement the power to originate
// it. Staff review what employees file; employees file through POST
// /api/v1/my/expenses, which derives the claimant from the session and therefore
// cannot be pointed at anybody else.
//
// The route is GONE rather than gated to a role, so it 404s. A permanently-403
// route is a disabled feature with a working URL, and the next person to add a
// create button finds it answers instead of finding it refused. See
// tests/expenseClaimCreationRestricted.test.js, which fails if this comes back.
router.get("/expense-claims", expenseView, asyncHandler(listExpenseClaims));
router.get("/expense-claims/:uuid", expenseView, asyncHandler(getExpenseClaim));
// Registered BEFORE the /:uuid routes deliberately. Express matches in
// registration order, so a literal segment sitting behind a parameter is one
// refactor away from being swallowed by it. `/bulk-pay` as a uuid string would
// reach loadClaim and 404 with a confusing message instead of paying anything.
router.post("/expense-claims/bulk-pay", expensePay, asyncHandler(bulkPayExpenseClaims));
router.post("/expense-claims/:uuid/review", expenseApprove, asyncHandler(reviewExpenseClaim));
router.post("/expense-claims/:uuid/pay", expensePay, asyncHandler(payExpenseClaim));
router.post(
  "/expense-claims/:uuid/receipts",
  expenseApprove,
  uploadAttachments.array("files", 10),
  asyncHandler(uploadExpenseReceipts),
);
router.delete(
  "/expense-attachments/:attachmentUuid",
  expenseApprove,
  asyncHandler(removeExpenseReceipt),
);
router.get(
  "/expense-attachments/:attachmentUuid/download",
  expenseView,
  asyncHandler(downloadExpenseReceipt),
);

// ---- Org dashboard analytics (staff) ----
router.get("/dashboard/analytics", [...staff, requirePermission("reports.view_org_analytics"), requireOrganizationWideReportsScope], asyncHandler(orgDashboardAnalytics));

import {
  uploadReceipts,
  listReceipts,
  removeAttachment,
  downloadAttachment,
  listAssets,
  createAsset,
  getAsset,
  updateAsset,
  summary,
  assignAsset,
  returnAsset,
  retireAsset,
  reinstateAsset,
} from "../controllers/org/assets.controller.js";

export default router;
