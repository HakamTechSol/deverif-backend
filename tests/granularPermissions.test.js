import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DATA_SCOPES,
  GRANULAR_PERMISSION_CATALOG,
  hasPermission,
  normalizedFeatureAccess,
  parseGranularPermissions,
} from "../src/utils/permissions.js";

const ORG_ROUTES = readFileSync("src/routes/org.routes.js", "utf8");
const ADMIN_PERMISSION_UI = readFileSync("../frontend/src/routes/_app.org.admins.tsx", "utf8");
const LEAVE_ROUTES = readFileSync("src/routes/leaves.routes.js", "utf8");
const VERIFICATION_ROUTES = readFileSync("src/routes/verification.routes.js", "utf8");
const VERIFICATION_CONTROLLER = readFileSync("src/controllers/verification.controller.js", "utf8");
const EMPLOYEE_DETAIL = readFileSync("../frontend/src/routes/_app.org.team.$uuid.tsx", "utf8");
const EMPLOYEE_MANAGER = readFileSync("../frontend/src/components/employees/EmployeeManager.tsx", "utf8");
const MANAGE_OPTIONS_DIALOG = readFileSync("../frontend/src/components/employees/ManageOptionsDialog.tsx", "utf8");
const ATTENDANCE_UI = readFileSync("../frontend/src/routes/_app.org.attendance.tsx", "utf8");
const APP_SHELL = readFileSync("../frontend/src/components/layout/AppShell.tsx", "utf8");
const LEAVE_UI = readFileSync("../frontend/src/routes/_app.org.leaves.tsx", "utf8");
const PAYROLL_UI = readFileSync("../frontend/src/routes/_app.org.payroll.tsx", "utf8");
const SALARY_COMPONENTS_UI = readFileSync("../frontend/src/components/salary/SalaryComponentsManager.tsx", "utf8");
const HR_LETTERS_UI = readFileSync("../frontend/src/routes/_app.org.hr-letters.tsx", "utf8");
const LETTER_TEMPLATES_UI = readFileSync("../frontend/src/routes/_app.org.letter-templates.tsx", "utf8");
const EMPLOYEE_LETTERS_UI = readFileSync("../frontend/src/components/hr/EmployeeLettersPanel.tsx", "utf8");
const ISSUE_LETTER_DIALOG = readFileSync("../frontend/src/components/hr/IssueLetterDialog.tsx", "utf8");

describe("granular permission catalog", () => {
  it("never exposes the hard-delete employee controller through the org API", () => {
    expect(ORG_ROUTES).toContain('router.delete("/employees/:uuid", employeeArchive, asyncHandler(archiveReference));');
    expect(ORG_ROUTES).not.toMatch(/router\.delete\(["']\/employees\/:uuid["'][^\n]*deleteEmployee/);
  });
  it("defines the complete requested module/action catalog without duplicate keys", () => {
    const keys = Object.entries(GRANULAR_PERMISSION_CATALOG).flatMap(([module, actions]) =>
      actions.map((action) => `${module}.${action}`),
    );
    expect(keys.length).toBe(61);
    expect(new Set(keys).size).toBe(keys.length);
    expect(GRANULAR_PERMISSION_CATALOG.leave_management).not.toContain("submit_on_behalf");
    expect(ADMIN_PERMISSION_UI).not.toContain("submit_on_behalf");
  });

  it("keeps the frontend checkbox catalog exactly aligned with the backend catalog", () => {
    const backendKeys = Object.entries(GRANULAR_PERMISSION_CATALOG).flatMap(([module, actions]) =>
      actions.map((action) => `${module}.${action}`),
    ).sort();
    const frontendKeys = ADMIN_PERMISSION_UI.split(/\r?\n/).flatMap((line) => {
      const moduleMatch = line.match(/key: "([a-z_]+)".*actions: \[(.*)\] \},?$/);
      if (!moduleMatch) return [];
      return [...moduleMatch[2].matchAll(/\["([a-z_]+)","[^"]+"\]/g)]
        .map((match) => `${moduleMatch[1]}.${match[1]}`);
    }).sort();
    expect(frontendKeys).toEqual(backendKeys);
  });

  it("routes leave decisions through separate approve and reject permissions", () => {
    expect(LEAVE_ROUTES).toContain('"leave_management.approve"');
    expect(LEAVE_ROUTES).toContain('"leave_management.reject"');
    expect(LEAVE_ROUTES).not.toContain('"leave_management.cancel"');
    expect(LEAVE_ROUTES).toContain("Sub-admin leave cancellation is not available");
  });

  it("keeps leave write controls behind their exact permissions", () => {
    const viewOnly = {
      org_role: "sub_admin",
      feature_access: {
        granular_permissions: {
          "leave_management.view": true,
          "leave_management.approve": false,
          "leave_management.reject": false,
          "leave_management.allocate_balance": false,
          "leave_management.manage_leave_types": false,
        },
      },
    };
    expect(hasPermission(viewOnly, "leave_management.view")).toBe(true);
    expect(hasPermission(viewOnly, "leave_management.approve")).toBe(false);
    expect(hasPermission(viewOnly, "leave_management.reject")).toBe(false);
    expect(hasPermission(viewOnly, "leave_management.allocate_balance")).toBe(false);
    expect(hasPermission(viewOnly, "leave_management.manage_leave_types")).toBe(false);

    expect(LEAVE_UI).toContain('permissions.hasGranular("leave_management.approve", "leave")');
    expect(LEAVE_UI).toContain('permissions.hasGranular("leave_management.reject", "leave")');
    expect(LEAVE_UI).toContain('permissions.hasGranular("leave_management.allocate_balance", "leave")');
    expect(LEAVE_UI).toContain('permissions.hasGranular("leave_management.manage_leave_types", "leave")');
    expect(LEAVE_UI).toContain("{canManageLeaveTypes ? (");
    expect(LEAVE_UI).toContain("{canAllocateBalance ? (");
    expect(LEAVE_UI).toContain("<AllocationsTab canAllocate={canAllocateBalance} />");

    expect(ORG_ROUTES).toContain('router.post("/leave-types", leaveTypesManage, asyncHandler(createLeaveType));');
    expect(ORG_ROUTES).toContain('router.put("/leave-types/:id", leaveTypesManage, asyncHandler(updateLeaveType));');
    expect(ORG_ROUTES).toContain('router.delete("/leave-types/:id", [...leaveTypesManage, requireRole("org_admin")], asyncHandler(deleteLeaveType));');
    expect(ORG_ROUTES).toContain('router.get("/leave-allocations", leaveAllocate, asyncHandler(listLeaveAllocations));');
    expect(ORG_ROUTES).toContain('router.get("/employees/:uuid/leave-allocations", leaveAllocate, asyncHandler(getEmployeeLeaveHistory));');
  });

  it("loads Leave employee filter options through Leave View and its data scope", () => {
    expect(ORG_ROUTES).toContain('router.get("/leave-employees", leaveView, asyncHandler(listLeaveEmployees));');
    expect(LEAVE_UI).toContain("orgLeavesService.filterEmployees");
    expect(LEAVE_UI).not.toContain("orgService.employees");
  });

  it("routes verification decisions through exact approve and reject permissions", () => {
    expect(VERIFICATION_ROUTES).toContain("requireOrganizationInboxScope");
    expect(VERIFICATION_CONTROLLER).toContain('"document_verification.approve"');
    expect(VERIFICATION_CONTROLLER).toContain('"document_verification.reject"');
  });

  it("defaults every granular action to denied", () => {
    const parsed = parseGranularPermissions(null);
    for (const actions of Object.entries(GRANULAR_PERMISSION_CATALOG)) {
      for (const action of actions[1]) expect(parsed[`${actions[0]}.${action}`]).toBe(false);
    }
  });

  it("keeps legacy access working until a granular matrix is explicitly saved", () => {
    const user = { org_role: "sub_admin", feature_access: { manage_employees: true } };
    expect(hasPermission(user, "employees.view")).toBe(true);
    expect(hasPermission(user, "employees.archive")).toBe(true);
    expect(hasPermission(user, "employees.view")).toBe(true);
    expect(hasPermission(user, "assets.view")).toBe(false);
  });

  it("treats a saved granular matrix as authoritative over legacy broad grants", () => {
    const user = {
      org_role: "sub_admin",
      feature_access: {
        manage_employees: true,
        granular_permissions: { "employees.view": true, "employees.archive": false },
      },
    };
    expect(hasPermission(user, "employees.view")).toBe(true);
    expect(hasPermission(user, "employees.archive")).toBe(false);
    expect(hasPermission(user, "employees.create")).toBe(false);
  });

  it("denies employee edits when the exact edit action was not granted", () => {
    const user = {
      org_role: "sub_admin",
      feature_access: {
        manage_employees: true,
        granular_permissions: { "employees.view": true, "employees.edit": false },
      },
    };
    expect(hasPermission(user, "employees.view")).toBe(true);
    expect(hasPermission(user, "employees.edit")).toBe(false);
    expect(ORG_ROUTES).toContain('const employeeEdit = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.edit")];');
    expect(ORG_ROUTES).toContain('router.put("/employees/:uuid", employeeEdit, asyncHandler(updateEmployee));');
  });

  it("keeps employee detail payroll UI behind payroll.view", () => {
    expect(EMPLOYEE_DETAIL).toContain('perms.hasGranular("payroll.view", "payroll")');
    expect(EMPLOYEE_DETAIL).toContain('canViewPayroll ? [["payroll", "Payroll"] as const] : []');
  });

  it("keeps employee payroll writes behind their dedicated permission", () => {
    expect(EMPLOYEE_DETAIL).toContain('perms.hasGranular("payroll.adjust_salary", "payroll")');
    expect(EMPLOYEE_DETAIL).toContain('perms.hasGranular("payroll.manage_employee_components", "payroll")');
    expect(EMPLOYEE_DETAIL).toContain("{canAdjustSalary ? (");
    expect(ORG_ROUTES).toContain('requirePermission("payroll.manage_employee_components")');
    expect(ORG_ROUTES).toContain('requirePermission("payroll.adjust_salary")');
    expect(ORG_ROUTES).toContain('router.post("/employees/:uuid/increment-salary", payrollSalaryAccess, payrollEmployeeScope, asyncHandler(incrementEmployeeSalary));');
    expect(ORG_ROUTES).toContain('router.post("/employees/:uuid/salary-components", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(assignEmployeeSalaryComponent));');
    expect(ORG_ROUTES).toContain('router.put("/employees/:uuid/salary-components/:assignUuid", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(updateEmployeeSalaryComponent));');
    expect(ORG_ROUTES).toContain('router.delete("/employees/:uuid/salary-components/:assignUuid", payrollEmployeeComponentsAccess, payrollEmployeeScope, asyncHandler(removeEmployeeSalaryComponent));');
    expect(ORG_ROUTES).toContain('router.get("/payroll-settings", payrollView, asyncHandler(getPayrollSettings));');
    expect(ORG_ROUTES).toContain('router.put("/payroll-settings", payrollSettingsAccess, asyncHandler(updatePayrollSettings));');
    expect(ORG_ROUTES).toContain('router.get("/payroll-schedule", payrollView, asyncHandler(getMonthlyWorkSchedule));');
    expect(ORG_ROUTES).toContain('router.put("/payroll-schedule", payrollSettingsAccess, asyncHandler(saveMonthlyWorkSchedule));');
    expect(ORG_ROUTES).toContain('router.get("/salary-components", payrollView, asyncHandler(listSalaryComponents));');
    expect(ORG_ROUTES).toContain('router.post("/salary-components", payrollSettingsAccess, asyncHandler(createSalaryComponent));');
    expect(ORG_ROUTES).not.toContain("payrollOrgWideScope");
  });

  it("shows payroll controls only for their exact grants", () => {
    expect(PAYROLL_UI).toContain('perms.hasGranular("payroll.generate", "payroll")');
    expect(PAYROLL_UI).toContain('perms.hasGranular("reports.export")');
    expect(PAYROLL_UI).toContain("canViewPayroll ? <TabsTrigger value=\"employees\"");
    expect(PAYROLL_UI).toContain("canManagePayrollSettings ? <TabsTrigger value=\"components\"");
    expect(PAYROLL_UI).toContain("canManagePayrollSettings ? <TabsTrigger value=\"policies\"");
    expect(PAYROLL_UI).toContain("{canGeneratePayroll ? <Checkbox");
    expect(PAYROLL_UI).toContain("Payroll Settings");
    expect(SALARY_COMPONENTS_UI).toContain("export function SalaryComponentsManager({ canManage }: { canManage: boolean })");
    expect(SALARY_COMPONENTS_UI).toContain("canManage ? <Button size=\"sm\"");
  });

  it("gates HR letter controls by their exact grants and shared template scope", () => {
    for (const permission of [
      "hr_letters.create_draft",
      "hr_letters.edit_draft",
      "hr_letters.issue",
      "hr_letters.revoke",
    ]) {
      expect(HR_LETTERS_UI).toContain(`permissions.hasGranular("${permission}", "hr_letters")`);
    }
    expect(HR_LETTERS_UI).toContain("canCreateLetter ? (");
    expect(HR_LETTERS_UI).toContain("permissions.isOrgAdmin ? (");
    expect(EMPLOYEE_LETTERS_UI).toContain('permissions.hasGranular("hr_letters.create_draft", "hr_letters")');
    expect(EMPLOYEE_LETTERS_UI).toContain('permissions.hasGranular("hr_letters.edit_draft", "hr_letters")');
    expect(EMPLOYEE_LETTERS_UI).toContain('permissions.hasGranular("hr_letters.issue", "hr_letters")');
    expect(EMPLOYEE_LETTERS_UI).toContain("permissions.isOrgAdmin ? (");
    expect(ISSUE_LETTER_DIALOG).toContain("canSaveDraft = true");
    expect(LETTER_TEMPLATES_UI).toContain('permissions.hasGranular("hr_letters.manage_templates", "hr_letters")');
    expect(LETTER_TEMPLATES_UI).toContain("enabled: hasTemplateScope");
    expect(LETTER_TEMPLATES_UI).toContain("!hasTemplateScope");
    expect(ORG_ROUTES).toContain('requireEntireModuleScope("hr_letters")');
    expect(ORG_ROUTES).toContain('requirePermission("hr_letters.manage_templates")');
  });

  it("keeps department and designation management behind their exact permissions", () => {
    expect(EMPLOYEE_MANAGER).toContain('hasGranularPermission(user, "employees.manage_departments", "manage_employees")');
    expect(EMPLOYEE_MANAGER).toContain('hasGranularPermission(user, "employees.manage_designations", "manage_employees")');
    expect(MANAGE_OPTIONS_DIALOG).toContain('hasGranularPermission(user, permission, "manage_employees")');
    expect(ORG_ROUTES).toContain('const departmentManage = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.manage_departments")];');
    expect(ORG_ROUTES).toContain('const designationManage = [...staff, requireModuleFeature("employee_management"), requirePermission("employees.manage_designations")];');
    expect(ORG_ROUTES).not.toContain('requirePermission("employees.manage_departments"), employeeOrgWideScope');
    expect(ORG_ROUTES).not.toContain('requirePermission("employees.manage_designations"), employeeOrgWideScope');
  });

  it("auto-grants view when an action requires it", () => {
    const saved = normalizedFeatureAccess({
      granular_permissions: {
        "employees.create": true,
        "employees.view": false,
        "hr_letters.create_draft": true,
        "hr_letters.edit_draft": true,
        "hr_letters.issue": true,
        "hr_letters.revoke": true,
        "hr_letters.manage_templates": true,
        "hr_letters.view": false,
        "leave_management.allocate_balance": true,
        "leave_management.view": false,
        "payroll.generate": true,
        "payroll.manage_settings": true,
        "payroll.manage_employee_components": true,
        "payroll.adjust_salary": true,
        "payroll.view": false,
      },
    });
    expect(saved.granular_permissions["employees.view"]).toBe(true);
    expect(saved.granular_permissions["hr_letters.view"]).toBe(true);
    expect(saved.granular_permissions["leave_management.view"]).toBe(true);
    expect(saved.granular_permissions["payroll.view"]).toBe(true);

    for (const action of [
      "hr_letters.create_draft",
      "hr_letters.edit_draft",
      "hr_letters.issue",
      "hr_letters.revoke",
      "hr_letters.manage_templates",
    ]) {
      const actionOnly = normalizedFeatureAccess({
        granular_permissions: { [action]: true, "hr_letters.view": false },
      });
      expect(actionOnly.granular_permissions["hr_letters.view"], action).toBe(true);
    }
  });

  it("removes permissions with no delegated use and restricts overtime changes to Org Admin", () => {
    expect(GRANULAR_PERMISSION_CATALOG.document_verification).not.toContain("download_documents");
    expect(GRANULAR_PERMISSION_CATALOG.attendance).not.toContain("approve_overtime");
    expect(GRANULAR_PERMISSION_CATALOG.leave_management).not.toContain("cancel");
    expect(GRANULAR_PERMISSION_CATALOG.expenses).not.toContain("export");
    expect(ORG_ROUTES).toContain('router.post("/overtime-requests", attendanceMgmtOwner, asyncHandler(createOvertimeRequest));');
    expect(ORG_ROUTES).toContain('router.post("/overtime-requests/:uuid/decide", attendanceMgmtOwner, asyncHandler(decideOvertimeRequest));');
  });

  it("gates attendance controls by exact grants and reserves missing attendance for manual-entry users", () => {
    const viewOnly = {
      org_role: "sub_admin",
      feature_access: {
        granular_permissions: {
          "attendance.view": true,
          "attendance.manual_entry": false,
          "attendance.correct_check_in_out": false,
          "attendance.manage_ips": false,
        },
      },
    };
    expect(hasPermission(viewOnly, "attendance.view")).toBe(true);
    expect(hasPermission(viewOnly, "attendance.manual_entry")).toBe(false);
    expect(hasPermission(viewOnly, "attendance.correct_check_in_out")).toBe(false);
    expect(hasPermission(viewOnly, "attendance.manage_ips")).toBe(false);
    expect(ORG_ROUTES).toContain('router.get("/attendance/missing", attendanceManual, asyncHandler(listMissingAttendance));');
    expect(ORG_ROUTES).toContain('router.post("/attendance/missing/manual-entry", attendanceManual, asyncHandler(manualMissingEntry));');
    expect(ATTENDANCE_UI).toContain('hasGranularPermission(user, "attendance.manual_entry", "attendance")');
    expect(ATTENDANCE_UI).toContain('hasGranularPermission(user, "attendance.correct_check_in_out", "attendance")');
    expect(ATTENDANCE_UI).toContain('hasGranularPermission(user, "attendance.manage_ips", "attendance")');
    expect(ATTENDANCE_UI).toContain('onMarkAttendance={(item) => {');
    expect(ATTENDANCE_UI).toContain('setManualTarget({ employeeUuid: item.employee_uuid, date: item.date });');
    expect(ATTENDANCE_UI).toContain('orgAttendanceService.manualMissingEntry(data)');
    expect(ATTENDANCE_UI).toContain('disabled={isMissingEntry}');
  });

  it("refreshes active sub-admin permissions without changing Org Admin access", () => {
    expect(APP_SHELL).toContain('refetchInterval: user?.org_role === "sub_admin" ? 30_000 : false');
    expect(APP_SHELL).toContain("refetchOnWindowFocus: true");
    expect(hasPermission({ org_role: "org_admin" }, "attendance.correct_check_in_out")).toBe(true);
  });

  it("labels HR letter creation without changing its API permission key", () => {
    expect(ADMIN_PERMISSION_UI).toContain('["create_draft","Create Letter"]');
    expect(ORG_ROUTES).toContain('requirePermission("hr_letters.create_draft")');
  });

  it("does not let malformed granular values grant access", () => {
    expect(parseGranularPermissions("{broken}")).toEqual(
      Object.fromEntries(
        Object.values(GRANULAR_PERMISSION_CATALOG).flatMap((actions, index) =>
          actions.map((action) => [`${Object.keys(GRANULAR_PERMISSION_CATALOG)[index]}.${action}`, false]),
        ),
      ),
    );
  });

  it("validates data scopes and defaults omitted scopes to own records", () => {
    const saved = normalizedFeatureAccess({
      feature_access: {},
      granular_permissions: { "employees.view": true },
      data_scopes: { employees: "entire_organization", attendance: "invalid" },
    });
    expect(saved.granular_permissions["employees.view"]).toBe(true);
    expect(saved.data_scopes.employees).toBe("entire_organization");
    expect(saved.data_scopes.attendance).toBe("own_records");
    expect(DATA_SCOPES).toEqual(["own_records", "entire_organization"]);
    expect(normalizedFeatureAccess({
      data_scopes: { employees: "my_team" },
    }).data_scopes.employees).toBe("own_records");
  });

  it("grants each explicit action independently apart from its required view action", () => {
    const requiredViewByAction = {
      "employees.create": "employees.view",
      "document_verification.generate_request": "document_verification.view_requests",
      "leave_management.allocate_balance": "leave_management.view",
      "payroll.generate": "payroll.view",
      "payroll.manage_settings": "payroll.view",
      "payroll.manage_employee_components": "payroll.view",
      "payroll.adjust_salary": "payroll.view",
      "expenses.create_own": "expenses.view",
      "hr_letters.create_draft": "hr_letters.view",
      "hr_letters.edit_draft": "hr_letters.view",
      "hr_letters.issue": "hr_letters.view",
      "hr_letters.revoke": "hr_letters.view",
      "hr_letters.manage_templates": "hr_letters.view",
      "assets.create": "assets.view",
      "recruitment.create_job": "recruitment.view",
    };
    const allKeys = Object.entries(GRANULAR_PERMISSION_CATALOG).flatMap(([module, actions]) =>
      actions.map((action) => `${module}.${action}`),
    );
    for (const key of allKeys) {
      const user = { org_role: "sub_admin", feature_access: { granular_permissions: { [key]: true } } };
      expect(hasPermission(user, key), key).toBe(true);
      for (const other of allKeys) {
        if (other === key || requiredViewByAction[key] === other) continue;
        expect(hasPermission(user, other), `${key} leaked into ${other}`).toBe(false);
      }
      if (requiredViewByAction[key]) {
        expect(hasPermission(user, requiredViewByAction[key]), `${key} did not grant its view action`).toBe(true);
      }
    }
  });

  it("preserves legacy expense view, approval and payment grants before granular setup", () => {
    const legacy = { org_role: "sub_admin", feature_access: { approve_expenses: true } };
    expect(hasPermission(legacy, "expenses.view")).toBe(true);
    expect(hasPermission(legacy, "expenses.approve_employee")).toBe(true);
    expect(hasPermission(legacy, "expenses.process_payment")).toBe(true);
    expect(hasPermission(legacy, "expenses.create_own")).toBe(false);
  });

  it("keeps org_admin unrestricted", () => {
    expect(hasPermission({ org_role: "org_admin" }, "employees.archive")).toBe(true);
  });
});
