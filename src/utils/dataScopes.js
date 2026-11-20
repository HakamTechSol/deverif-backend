import { pool } from "../config/db.js";
import ApiError from "./ApiError.js";

const VALID_SCOPES = new Set(["own_records", "entire_organization"]);

function readFeatureAccess(value) {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Legacy users without a saved data_scopes object retain their previous
 * organization-wide visibility. New granular permission saves always include
 * an explicit scope per module.
 */
export function getDataScope(user, moduleKey) {
  if (!user || user.org_role === "org_admin") return "entire_organization";
  const access = readFeatureAccess(user.feature_access);
  const scopes = access.data_scopes;
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) return "entire_organization";
  const value = scopes[moduleKey];
  return VALID_SCOPES.has(value) ? value : "own_records";
}

/**
 * SQL predicate for employee-linked tables joined as the supplied trusted alias.
 * Own Records means records created by this user, not records merely linked to
 * their login account.
 */
export function employeeScopeCondition(req, moduleKey, employeeAlias = "e") {
  const scope = getDataScope(req.user, moduleKey);
  if (scope === "entire_organization") return null;
  if (scope === "own_records") {
    return {
      sql: `${employeeAlias}.added_by_uuid = ?`,
      params: [req.user.uuid],
    };
  }
  return null;
}

/** SQL predicate for records owned by a user (e.g. job openings and candidates). */
export function creatorScopeCondition(req, moduleKey, recordAlias = "r") {
  const scope = getDataScope(req.user, moduleKey);
  if (scope === "entire_organization") return null;
  if (scope === "own_records") {
    return { sql: `${recordAlias}.created_by_uuid = ?`, params: [req.user.uuid] };
  }
  return null;
}

/** Scope-check a creator-owned recruitment record before UUID-based operations. */
export async function assertCreatedRecordInDataScope(req, moduleKey, tableName, recordUuid) {
  const allowedTables = new Set(["candidates", "job_openings", "assets"]);
  if (!allowedTables.has(tableName)) throw new ApiError(500, "Invalid scoped record type");
  const scope = getDataScope(req.user, moduleKey);
  if (scope === "entire_organization") return;
  const [rows] = await pool.query(
    `SELECT created_by_uuid FROM ${tableName} WHERE uuid = ? AND organization_id = ? LIMIT 1`,
    [recordUuid, req.scopeOrgId ?? req.user.organization],
  );
  if (!rows.length) throw new ApiError(404, "Record not found");
  const creatorUuid = rows[0].created_by_uuid;
  if (scope === "own_records") {
    if (creatorUuid !== req.user.uuid) throw new ApiError(404, "Record not found");
    return;
  }
}

/** Prevent direct UUID endpoints from bypassing the list's employee scope. */
export async function assertEmployeeInDataScope(req, moduleKey, employeeUuid) {
  const condition = employeeScopeCondition(req, moduleKey, "e");
  if (!condition) return;
  const orgId = req.scopeOrgId ?? req.user.organization;
  const [rows] = await pool.query(
    `SELECT e.uuid FROM employees e WHERE e.uuid = ? AND e.organization_id = ? AND ${condition.sql} LIMIT 1`,
    [employeeUuid, orgId, ...condition.params],
  );
  if (!rows.length) throw new ApiError(404, "Employee not found");
}
