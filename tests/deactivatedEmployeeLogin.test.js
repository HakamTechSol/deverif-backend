import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A deactivated platform employee must not be able to log in.
 *
 * THE BUG THIS PINS. Both password-login paths looked up the linked employee with
 *
 *     SELECT is_platform_user, status FROM employees WHERE linked_user_uuid = ?
 *     -- bound to [user.id]
 *
 * `linked_user_uuid` holds a UUID - employeeAccess.service.js writes
 * `linked_user_uuid = user.uuid` when an employee is promoted to a portal user.
 * `users.id` is an unrelated auto-increment integer. The comparison therefore
 * matches zero rows, `employees` comes back empty, the guard's condition is
 * skipped entirely, and a deactivated employee could still authenticate with
 * their password - the one remaining path, because authUser.js and
 * auth.otp.controller.js were already passing a uuid.
 *
 * WHY THIS TEST FAILS IF THE BUG RETURNS. The employees lookup below is not a
 * hand-written mock that always returns a row: it answers the way MySQL does,
 * returning the deactivated row ONLY when the bound parameter is the UUID. So a
 * regression to `user.id` yields an empty result, the 403 is never thrown, the
 * login proceeds, and the test fails on the assertion - not on a mock detail.
 * A test that mocks the guard's own output would pass against the broken code.
 */

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));
vi.mock("../src/utils/otp.js", () => ({
  generateOtp: vi.fn(() => "123456"),
  hashOtp: vi.fn(async (v) => `hashed:${v}`),
  storeOtp: vi.fn(async () => {}),
  invalidateOtps: vi.fn(async () => {}),
}));
vi.mock("../src/utils/mailer.js", () => ({ sendLoginOtpEmail: vi.fn(async () => {}) }));
vi.mock("../src/utils/loginHistory.js", () => ({ logLoginAttempt: vi.fn(async () => {}) }));
vi.mock("../src/utils/password.js", () => ({
  comparePassword: vi.fn(async () => true),
  hashPassword: vi.fn(async (v) => `hashed:${v}`),
  validatePasswordPolicy: vi.fn(() => true),
}));
vi.mock("../src/utils/jwt.js", () => ({
  signAccessToken: vi.fn(() => "access.token.value"),
  signRefreshToken: vi.fn(() => "refresh.token.value"),
  verifyAccessToken: vi.fn(),
}));
vi.mock("../src/utils/tokenBlacklist.js", () => ({ blacklistToken: vi.fn(async () => {}) }));
vi.mock("../src/utils/refreshToken.js", () => ({
  storeRefreshToken: vi.fn(async () => {}),
  revokeRefreshToken: vi.fn(async () => {}),
  revokeAllRefreshTokens: vi.fn(async () => {}),
}));

import { pool } from "../src/config/db.js";
import { comparePassword } from "../src/utils/password.js";
import { login } from "../src/controllers/auth.login.controller.js";
import { loginUser } from "../src/controllers/auth.user.controller.js";

/**
 * Deliberately unlike values. USER_UUID is what `linked_user_uuid` contains;
 * USER_ID is the integer primary key. Any query comparing the uuid column against
 * USER_ID is reproducing the bug, and the fake below will return nothing.
 */
const USER_UUID = "9f2b7c11-4a55-4d3e-8c10-77ab19e4de01";
const USER_ID = 4213;

const ACTIVE_USER = {
  id: USER_ID,
  uuid: USER_UUID,
  full_name: "Deactivated Employee",
  email: "deactivated@example.com",
  // users.status is still 'active'. Only the EMPLOYEE row was deactivated, which
  // is exactly the state this guard exists to catch.
  password: "hashed",
  status: "active",
  profile_image: null,
  organization: 7,
  org_role: "employee",
  feature_access: null,
  preferred_language: "en",
};

const DEACTIVATED_EMPLOYEE = { is_platform_user: "yes", status: "inactive" };

function makeRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.cookie = vi.fn(() => res);
  return res;
}

/**
 * Routes pool.query by the SQL it is given, and makes the employees lookup
 * behave like MySQL: a match only when the bound parameter equals the UUID.
 */
function installPool({ employee = DEACTIVATED_EMPLOYEE } = {}) {
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/FROM\s+users/i.test(sql)) return [[ACTIVE_USER]];
    if (/FROM\s+employees/i.test(sql)) {
      // The column is a CHAR(36) uuid. An integer primary key never matches it.
      const matches = params[0] === USER_UUID && employee ? [employee] : [];
      return [matches];
    }
    return [[]];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  comparePassword.mockResolvedValue(true);
});

describe("deactivated platform employees cannot log in", () => {
  it("OTP-issuing login rejects a deactivated employee (auth.login.controller)", async () => {
    installPool();

    await expect(
      login({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).rejects.toMatchObject({ statusCode: 403 });

    // The guard must be reached with the UUID, not the integer key.
    const employeesCall = pool.query.mock.calls.find(([sql]) => /FROM\s+employees/i.test(sql));
    expect(employeesCall, "the linked-employee lookup never ran").toBeTruthy();
    expect(employeesCall[1]).toEqual([USER_UUID]);
    expect(employeesCall[1]).not.toEqual([USER_ID]);
  });

  it("password login rejects a deactivated employee (auth.user.controller)", async () => {
    installPool();

    await expect(
      loginUser({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).rejects.toMatchObject({ statusCode: 403 });

    const employeesCall = pool.query.mock.calls.find(([sql]) => /FROM\s+employees/i.test(sql));
    expect(employeesCall, "the linked-employee lookup never ran").toBeTruthy();
    expect(employeesCall[1]).toEqual([USER_UUID]);
  });

  it("issues no OTP and no token for a rejected login", async () => {
    installPool();
    const { storeOtp } = await import("../src/utils/otp.js");
    const { signAccessToken } = await import("../src/utils/jwt.js");

    await expect(
      login({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).rejects.toThrow();
    await expect(
      loginUser({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).rejects.toThrow();

    expect(storeOtp).not.toHaveBeenCalled();
    expect(signAccessToken).not.toHaveBeenCalled();
  });

  it("still lets an ACTIVE platform employee through", async () => {
    // Guards against the fix being "always throw": the deactivated-row branch
    // must be the thing that decides, not the mere presence of a linked row.
    installPool({ employee: { is_platform_user: "yes", status: "active" } });

    await expect(
      login({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).resolves.toBeDefined();
  });

  it("does not block a roster-only employee (no linked row)", async () => {
    // employees returns [] when the lookup matches nothing, which is the normal
    // case for anyone without portal access. An empty result must NOT be treated
    // as "deactivated" — otherwise this guard would lock out ordinary users.
    installPool({ employee: null });

    await expect(
      login({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).resolves.toBeDefined();
  });

  it("does not block a platform employee whose USER row is deactivated", async () => {
    // That case is already handled by the users.status check, and it produces a
    // DIFFERENT message. The employee guard must not pre-empt it, or the two
    // deactivation paths would report indistinguishably.
    pool.query.mockImplementation(async (sql, params = []) => {
      if (/FROM\s+users/i.test(sql)) return [[{ ...ACTIVE_USER, status: "inactive" }]];
      if (/FROM\s+employees/i.test(sql)) return [[...(params[0] === USER_UUID && DEACTIVATED_EMPLOYEE ? [DEACTIVATED_EMPLOYEE] : [])]];
      return [[]];
    });

    await expect(
      loginUser({ body: { email: ACTIVE_USER.email, password: "correct-horse" } }, makeRes()),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});