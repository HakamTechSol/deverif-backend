import { describe, it, expect, vi, beforeEach } from "vitest";

import { assertEmailAvailable } from "../src/utils/identityUniqueness.js";

/**
 * The rule: one email address, one identity — across `users` AND `employees`.
 *
 * `users.email` is UNIQUE so that half was never in doubt. `employees.email` is
 * not, which is how an employee and an unrelated admin account came to share
 * one address with nothing linking them. These pin the check that closes it,
 * including the cases that must NOT fire (a linked employee's own profile save).
 *
 * The executor is a stub: the point is which query runs and what happens to the
 * rows it returns, not MySQL's behaviour.
 */

const EMPLOYEE_ROW = {
  uuid: "emp-uuid",
  full_name: "Hunain Haider",
  email: "hunainhaider811@gmail.com",
  employee_code: "EMP-001476",
  status: "current_employee",
  is_platform_user: "no",
  linked_user_uuid: null,
  organization_name: "Pixel2pro",
};

const USER_ROW = {
  uuid: "user-uuid",
  full_name: "HakamTechSol",
  email: "hunainhaider811@gmail.com",
};

/** Answers the users lookup, then the employees lookup. */
function stubExecutor({ users = [], employees = [] } = {}) {
  const calls = [];
  return {
    calls,
    query: vi.fn(async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/FROM users/i.test(sql)) {
        // Same for the self-exclusion on the account being edited.
        const excludesSelf = /AND uuid <> \?/.test(sql);
        const kept = excludesSelf ? users.filter((u) => u.uuid !== params[1]) : users;
        return [kept];
      }
      if (/FROM employees/i.test(sql)) {
        // Honour the linked_user_uuid exclusion the same way MySQL would,
        // otherwise this stub would report a conflict the real query filters
        // out and the "legitimately linked" case could never pass.
        const excludesLink = /linked_user_uuid IS NULL OR e\.linked_user_uuid <>/.test(sql);
        const kept = excludesLink
          ? employees.filter((e) => !e.linked_user_uuid || e.linked_user_uuid !== params[1])
          : employees;
        return [kept];
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  };
}

describe("assertEmailAvailable", () => {
  it("passes when neither table has the address", async () => {
    const ex = stubExecutor();
    await expect(assertEmailAvailable({ email: "new@example.com", executor: ex })).resolves.toBeUndefined();
    expect(ex.query).toHaveBeenCalledTimes(2);
  });

  it("refuses when an employee record already owns the address", async () => {
    // THE bug: employee created without portal access, admin then creates an
    // account on the same gmail. Must not be allowed to stand.
    const ex = stubExecutor({ employees: [EMPLOYEE_ROW] });
    await expect(
      assertEmailAvailable({ email: "hunainhaider811@gmail.com", executor: ex })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Hunain Haider"),
    });
  });

  it("names the employee code and organization so the admin knows which record", async () => {
    const ex = stubExecutor({ employees: [EMPLOYEE_ROW] });
    await expect(
      assertEmailAvailable({ email: "hunainhaider811@gmail.com", executor: ex })
    ).rejects.toThrow(/EMP-001476[\s\S]*Pixel2pro/);
  });

  it("points at the employee record rather than inviting a duplicate account", async () => {
    const ex = stubExecutor({ employees: [EMPLOYEE_ROW] });
    await expect(
      assertEmailAvailable({ email: "hunainhaider811@gmail.com", executor: ex })
    ).rejects.toThrow(/portal access from their employee record/i);
  });

  it("refuses when a user account already owns the address", async () => {
    const ex = stubExecutor({ users: [USER_ROW] });
    await expect(
      assertEmailAvailable({ email: "hunainhaider811@gmail.com", executor: ex })
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("HakamTechSol"),
    });
  });

  it("allows the employee this account is legitimately linked to", async () => {
    // The pair created by employeeAccess.service.js: the employee record and
    // its own account share an email BY DESIGN. Re-saving that user's profile
    // must not 409 them against their own employee row.
    const linked = { ...EMPLOYEE_ROW, linked_user_uuid: "user-uuid" };
    const ex = stubExecutor({ employees: [linked] });
    await expect(
      assertEmailAvailable({
        email: "hunainhaider811@gmail.com",
        executor: ex,
        linkedUserUuid: "user-uuid",
      })
    ).resolves.toBeUndefined();

    const empQuery = ex.calls.find((c) => /FROM employees/i.test(c.sql));
    expect(empQuery.sql).toMatch(/linked_user_uuid IS NULL OR e\.linked_user_uuid <>/);
    expect(empQuery.params).toContain("user-uuid");
  });

  it("still refuses a DIFFERENT employee when one linked record exists", async () => {
    // The exclusion is by link, not by "this org has a linked employee" — an
    // unlinked second employee on the same address is still a real conflict.
    const other = { ...EMPLOYEE_ROW, uuid: "emp-2", employee_code: "EMP-001999" };
    const ex = stubExecutor({ employees: [other] });
    await expect(
      assertEmailAvailable({ email: "x@y.com", executor: ex, linkedUserUuid: "user-uuid" })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("checks employees regardless of employment status", async () => {
    // Simple rule: one email, one identity. An ex-employee is still a person.
    const ex = stubExecutor({ employees: [{ ...EMPLOYEE_ROW, status: "ex_employee" }] });
    await expect(
      assertEmailAvailable({ email: "x@y.com", executor: ex })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it.each([["empty string", ""], ["whitespace", "   "], ["null", null], ["undefined", undefined]])(
    "skips the check for %s rather than failing the write",
    async (_label, value) => {
      const ex = stubExecutor();
      await expect(assertEmailAvailable({ email: value, executor: ex })).resolves.toBeUndefined();
      expect(ex.query).not.toHaveBeenCalled();
    }
  );

  it("allows the account being edited to keep its own email", async () => {
    // Regression: updateUser passes the whole body, so an unchanged email hits
    // the users lookup and matched the account itself — every profile save
    // 409'd. excludeUserUuid is what prevents that.
    const ex = stubExecutor({ users: [USER_ROW] });
    await expect(
      assertEmailAvailable({
        email: "hunainhaider811@gmail.com",
        executor: ex,
        excludeUserUuid: "user-uuid",
      })
    ).resolves.toBeUndefined();

    const userQuery = ex.calls.find((c) => /FROM users/i.test(c.sql));
    expect(userQuery.sql).toMatch(/AND uuid <> \?/);
    expect(userQuery.params).toContain("user-uuid");
  });

  it("skips the linked employee from excludeUserUuid alone", async () => {
    // updateUser passes one uuid, not two. The helper must reuse it for the
    // employee half too, or saving a linked employee's own profile 409s.
    const linked = { ...EMPLOYEE_ROW, linked_user_uuid: "user-uuid" };
    const ex = stubExecutor({ employees: [linked] });
    await expect(
      assertEmailAvailable({ email: "x@y.com", executor: ex, excludeUserUuid: "user-uuid" })
    ).resolves.toBeUndefined();

    const empQuery = ex.calls.find((c) => /FROM employees/i.test(c.sql));
    expect(empQuery.params).toContain("user-uuid");
  });

  it("still refuses a different account holding the email when excluding self", async () => {
    const other = { ...USER_ROW, uuid: "someone-else", full_name: "Someone Else" };
    const ex = stubExecutor({ users: [other] });
    await expect(
      assertEmailAvailable({ email: "x@y.com", executor: ex, excludeUserUuid: "user-uuid" })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("trims the value before matching", async () => {
    const ex = stubExecutor();
    await assertEmailAvailable({ email: "  a@b.com  ", executor: ex });
    expect(ex.calls[0].params[0]).toBe("a@b.com");
  });
});