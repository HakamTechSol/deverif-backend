import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { assertUuid } from "../utils/publicResponse.js";
import { logAudit } from "../utils/auditLog.js";
import { paginatedResponse } from "../utils/pagination.js";
import { buildInsert, buildUpdateStrict } from "../utils/crudHelpers.js";
import * as attachments from "./attachments.service.js";

/**
 * Asset management: inventory and custody.
 *
 * FILES ARE ATTACHMENTS, NOT COLUMNS. Purchase receipts go through the
 * polymorphic attachments table (entity_type 'asset') rather than a receipt_path
 * column. This is also the only version that gets tenant isolation, path-traversal
 * defence, soft delete and an audit entry per upload.
 *
 * Asset status is derived from its active custody assignment: assigned or
 * available. Retired is a terminal state until reinstated.
 *
 * Every mutation below recomputes it from the rows rather than trusting a
 * supplied value. The alternative — a `status` column a form posts — is the
 * reason spreadsheets disagree with their own contents: the column and the rows
 * beside it drift, and then the register is a work of fiction. Here the two
 * cannot disagree, because only one of them is writable.
 *
 * The database backs this up independently, so a bug in the service cannot leave
 * an asset held by two employees: `assets.active_assignment_guard` and
 * `asset_assignments.open_assignment_guard` are generated columns that are
 * UNIQUE only while the row is open. Both were verified to reject a second open
 * row, which the original (asset_uuid, returned_at) key did NOT.
 *
 * Every read is scoped by organization_id. No function here accepts an org id
 * from the request body — it always comes from the auth middleware, or a guessed
 * uuid 404s instead of leaking another tenant's inventory.
 */

/** Attachment entity types, namespaced to match the attachments table. */
export const ATTACHMENT_ENTITY = {
  ASSET: "asset",
};

/** Attachment category for a purchase receipt. */
export const ATTACHMENT_CATEGORY = {
  RECEIPT: "purchase_receipt",
};

export const ASSET_STATUSES = ["available", "assigned", "retired"];
const RETURN_CONDITIONS = ["good", "damaged"];

const ASSET_COLUMNS = [
  "asset_tag",
  "name",
  "model_details",
  "serial_number",
  "purchase_date",
  "purchase_cost",
  "vendor",
  "warranty_expires_at",
  "notes",
];

/**
 * Compose an INSERT from trusted columns plus client-supplied ones.
 *
 * buildInsert deliberately REFUSES organization_id, uuid, created_by_uuid, id and
 * created_at, so that a caller cannot inject a tenant id or forge an audit
 * author. Those columns are therefore not passed through it; they are composed
 * here from server-side values only. Passing them to buildInsert anyway throws,
 * which is the guard working as designed — so they are kept strictly separate.
 */
function composeInsert(trusted, clientRow, clientColumns) {
  const built = buildInsert(clientRow, clientColumns);
  const columns = [...Object.keys(trusted), ...built.columns];
  const params = [...Object.values(trusted), ...built.params];
  return {
    columns,
    placeholders: columns.map(() => "?"),
    params,
  };
}

function audit(actorUuid, action, entityType, entityId, orgId, details = {}) {
  logAudit({
    actorType: "user",
    actorId: actorUuid ?? null,
    action,
    entityType,
    entityId,
    details: { organization_id: orgId, ...details },
  });
}

async function employeeInOrg(orgId, employeeUuid, conn = pool) {
  // Trim first. A dropdown that submits nothing sends undefined or ""; one that
  // submits an unfilled input can send "   ". Left untrimmed, whitespace falls
  // through to assertUuid and blames the client for a malformed UUID when the
  // only real problem is that nobody was picked.
  const wanted = typeof employeeUuid === "string" ? employeeUuid.trim() : employeeUuid;
  if (!wanted) throw new ApiError(400, "Please select an employee");
  assertUuid(wanted, "Employee UUID");
  const [rows] = await conn.query(
    `SELECT uuid, full_name, linked_user_uuid
       FROM employees WHERE uuid=? AND organization_id=?`,
    [wanted, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Employee not found in this organization");
  return rows[0];
}

/**
 * Load an asset scoped to the org.
 *
 * forUpdate takes a row lock, because every state change below reads the current
 * status and then writes it. Without the lock, two concurrent assignments both
 * read "available", both decide they may proceed, and the second write silently
 * discards the first — the exact double-assignment the generated columns exist
 * to prevent, arriving by a different route.
 */
async function loadAsset(orgId, assetUuid, conn = pool, forUpdate = false) {
  assertUuid(assetUuid, "Asset UUID");
  const [rows] = await conn.query(
    `SELECT a.*
       FROM assets a
      WHERE a.uuid=? AND a.organization_id=?${forUpdate ? " FOR UPDATE" : ""}`,
    [assetUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Asset not found");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export async function listAssets({ orgId, page, limit, offset, search, status, employeeUuid, scopeFilter, creatorScopeFilter }) {
  const clauses = ["a.organization_id = ?"];
  const params = [orgId];

  if (status) {
    if (!ASSET_STATUSES.includes(status)) {
      throw new ApiError(400, `status must be one of: ${ASSET_STATUSES.join(", ")}`);
    }
    clauses.push("a.status = ?");
    params.push(status);
  }
  if (search) {
    clauses.push("(a.asset_tag LIKE ? OR a.name LIKE ? OR a.model_details LIKE ? OR a.serial_number LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (employeeUuid) {
    assertUuid(employeeUuid, "Employee UUID");
    clauses.push("EXISTS (SELECT 1 FROM asset_assignments af WHERE af.asset_uuid=a.uuid AND af.employee_uuid=? AND af.organization_id=a.organization_id AND af.returned_at IS NULL)");
    params.push(employeeUuid);
  }
  if (scopeFilter || creatorScopeFilter) {
    const visibleByAssignment = scopeFilter
      ? `EXISTS (SELECT 1 FROM asset_assignments sf JOIN employees e ON e.uuid=sf.employee_uuid WHERE sf.asset_uuid=a.uuid AND sf.organization_id=a.organization_id AND sf.returned_at IS NULL AND ${scopeFilter.sql})`
      : "0=1";
    const visibleByCreator = creatorScopeFilter ? creatorScopeFilter.sql : "0=1";
    clauses.push(`(${visibleByAssignment} OR ${visibleByCreator})`);
    params.push(...(scopeFilter?.params ?? []), ...(creatorScopeFilter?.params ?? []));
  }
  const where = clauses.join(" AND ");

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM assets a WHERE ${where}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT a.*,
            (SELECT e.full_name FROM asset_assignments g
               JOIN employees e ON e.uuid = g.employee_uuid
              WHERE g.asset_uuid = a.uuid AND g.returned_at IS NULL LIMIT 1) AS holder_name
       FROM assets a
      WHERE ${where}
      ORDER BY a.asset_tag
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return paginatedResponse(rows, total, page, limit);
}

export async function getAsset({ orgId, assetUuid }) {
  const asset = await loadAsset(orgId, assetUuid);

  const [history] = await pool.query(
    `SELECT g.uuid, g.assigned_at, g.returned_at, g.return_condition, g.return_notes,
            e.full_name AS employee_name, e.uuid AS employee_uuid
       FROM asset_assignments g
       JOIN employees e ON e.uuid = g.employee_uuid
      WHERE g.asset_uuid=?
      ORDER BY g.assigned_at DESC`,
    [assetUuid],
  );
  let receipts = [];
  try {
    receipts = await listReceipts({ orgId, assetUuid });
  } catch {
    receipts = [];
  }

  return {
    ...asset,
    holder: history.find((h) => !h.returned_at) ?? null,
    assignments: history,
    receipts,
  };
}

/** Next tag for a new asset: AST-0001, AST-0002, ... within the organization. */
async function nextAssetTag(conn, orgId) {
  const [[{ n }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM assets WHERE organization_id = ?",
    [orgId],
  );
  for (let i = n + 1; i < n + 1000; i += 1) {
    const candidate = `AST-${String(i).padStart(4, "0")}`;
    const [[hit]] = await conn.query(
      "SELECT 1 AS x FROM assets WHERE organization_id=? AND asset_tag=? LIMIT 1",
      [orgId, candidate],
    );
    if (!hit) return candidate;
  }
  throw new ApiError(500, "Could not allocate an asset tag");
}

export async function createAsset({ orgId, actorUuid, data }) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new ApiError(400, "name is required");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const tag = data.asset_tag ? String(data.asset_tag).trim() : await nextAssetTag(conn, orgId);
    if (!tag) throw new ApiError(400, "asset_tag cannot be empty");

    const insert = composeInsert(
      {
        organization_id: orgId,
        // Deliberately NOT taken from the request. A newly registered asset is
        // available by definition; 'assigned' can only arrive via assignAsset().
        status: "available",
        created_by_uuid: actorUuid ?? null,
      },
      {
        asset_tag: tag,
        name,
        model_details: data.model_details ?? null,
        serial_number: data.serial_number ?? null,
        purchase_date: data.purchase_date || null,
        purchase_cost: data.purchase_cost ?? null,
        vendor: data.vendor ?? null,
        warranty_expires_at: data.warranty_expires_at || null,
        notes: data.notes ?? null,
      },
      ASSET_COLUMNS,
    );

    let assetUuid;
    try {
      const [res] = await conn.query(
        `INSERT INTO assets (${insert.columns.join(", ")}) VALUES (${insert.placeholders.join(", ")})`,
        insert.params,
      );
      const [[row]] = await conn.query("SELECT uuid FROM assets WHERE id=?", [res.insertId]);
      assetUuid = row.uuid;
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, `Asset tag "${tag}" is already used in this organization`);
      }
      throw e;
    }

    await conn.commit();
    audit(actorUuid, "asset.create", "asset", assetUuid, orgId, { asset_tag: tag });
    return getAsset({ orgId, assetUuid });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export async function updateAsset({ orgId, actorUuid, assetUuid, data }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await loadAsset(orgId, assetUuid, conn, true);

    const update = buildUpdateStrict(
      {
        asset_tag: data.asset_tag === undefined ? undefined : String(data.asset_tag).trim(),
        name: data.name === undefined ? undefined : String(data.name).trim(),
        model_details: data.model_details,
        serial_number: data.serial_number,
        purchase_date: data.purchase_date || null,
        purchase_cost: data.purchase_cost ?? null,
        vendor: data.vendor ?? null,
        warranty_expires_at: data.warranty_expires_at || null,
        notes: data.notes ?? null,
      },
      ASSET_COLUMNS,
    );
    if (!update.columns.length) throw new ApiError(400, "No fields to update");

    try {
      await conn.query(
        `UPDATE assets ${update.clause} WHERE uuid=? AND organization_id=?`,
        [...update.params, assetUuid, orgId],
      );
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "That asset tag is already used in this organization");
      }
      throw e;
    }

    await conn.commit();
    audit(actorUuid, "asset.update", "asset", assetUuid, orgId);
    return getAsset({ orgId, assetUuid });
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Status derivation — the single writer
// ---------------------------------------------------------------------------

/**
 * Recompute an asset's status from its active assignment. Retired is terminal
 * and never overwritten here, because a scrapped asset stays scrapped.
 */
async function syncStatus(conn, orgId, assetUuid) {
  const [[a]] = await conn.query(
    "SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_uuid=? AND returned_at IS NULL",
    [assetUuid],
  );
  const next = a.n > 0 ? "assigned" : "available";
  await conn.query("UPDATE assets SET status=? WHERE uuid=? AND organization_id=? AND status<>'retired'", [
    next,
    assetUuid,
    orgId,
  ]);
  return next;
}

// ---------------------------------------------------------------------------
// Assignment / return
// ---------------------------------------------------------------------------

export async function assignAsset({ orgId, actorUuid, assetUuid, employeeUuid }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const asset = await loadAsset(orgId, assetUuid, conn, true);

    if (asset.status === "retired") {
      throw new ApiError(409, "A retired asset cannot be assigned");
    }
    if (asset.status === "assigned") {
      throw new ApiError(409, "This asset is already assigned. Return it first.");
    }

    const employee = await employeeInOrg(orgId, employeeUuid, conn);

    // Write employee.uuid - the value the lookup just confirmed is a real
    // employee in this organization - rather than echoing back whatever the
    // client sent. The two are the same string today, but storing the client
    // input means the assignment and the employee record can drift apart, and
    // /my/assets resolves its employee by joining on exactly this column.
    const [res] = await conn.query(
      `INSERT INTO asset_assignments
         (organization_id, asset_uuid, employee_uuid, assigned_by_uuid)
       VALUES (?, ?, ?, ?)`,
      [orgId, assetUuid, employee.uuid, actorUuid ?? null],
    );
    const [[row]] = await conn.query("SELECT uuid FROM asset_assignments WHERE id=?", [res.insertId]);

    const status = await syncStatus(conn, orgId, assetUuid);
    await conn.commit();

    audit(actorUuid, "asset.assign", "asset", assetUuid, orgId, {
      assignment_uuid: row.uuid,
      employee_uuid: employee.uuid,
      employee_name: employee.full_name,
    });
    return {
      assignment_uuid: row.uuid,
      status,
      employee_name: employee.full_name,
      // Not a warning for its own sake: /my/assets resolves the employee FROM the
      // session, i.e. via employees.linked_user_uuid. An employee with no portal
      // account can therefore never see this asset, and the assignment looks
      // perfectly healthy in every staff view. Saying so here is the only place
      // anyone can still act on it.
      employee_has_portal_account: Boolean(employee.linked_user_uuid),
    };
  } catch (e) {
    await conn.rollback();
    // The generated-column unique key is the backstop; translate it rather than
    // leaking a raw driver code to the client.
    if (e.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "This asset already has an open assignment");
    }
    throw e;
  } finally {
    conn.release();
  }
}

/** Take an asset back and record its condition in the custody history. */
export async function returnAsset({ orgId, actorUuid, assetUuid, condition = "good", notes }) {
  if (!RETURN_CONDITIONS.includes(condition)) {
    throw new ApiError(400, `condition must be one of: ${RETURN_CONDITIONS.join(", ")}`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const asset = await loadAsset(orgId, assetUuid, conn, true);

    if (asset.status === "retired") {
      throw new ApiError(409, "A retired asset cannot be returned");
    }

    const [res] = await conn.query(
      `UPDATE asset_assignments
          SET returned_at=NOW(), returned_to_uuid=?, return_condition=?, return_notes=?
        WHERE asset_uuid=? AND organization_id=? AND returned_at IS NULL`,
      [actorUuid ?? null, condition, notes ?? null, assetUuid, orgId],
    );
    if (!res.affectedRows) {
      throw new ApiError(409, "This asset is not currently assigned");
    }

    const status = await syncStatus(conn, orgId, assetUuid);
    await conn.commit();

    audit(actorUuid, "asset.return", "asset", assetUuid, orgId, { condition, notes: notes ?? null });
    return { status };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Employee self-service: MY assets
// ---------------------------------------------------------------------------

/**
 * The employee record behind the authenticated platform user, or null.
 *
 * Derived from the JWT + org scope, never from a request parameter. There is
 * deliberately no employee_uuid on the route: a caller who could name an id
 * could ask for someone else's hardware.
 */
async function employeeForUser(orgId, userUuid) {
  const [rows] = await pool.query(
    "SELECT uuid, full_name FROM employees WHERE organization_id=? AND linked_user_uuid=?",
    [orgId, userUuid],
  );
  return rows[0] ?? null;
}

/**
 * Assets currently assigned to the signed-in employee.
 *
 * CURRENTLY, ONLY. The custody history stays with HR; an employee asking "what
 * do I have" wants what is in their hands, and showing a returned laptop as still
 * theirs invites a support ticket about a device they do not have.
 *
 * Only non-sensitive columns are returned: tag, model, serial and the
 * assignment date. Deliberately NOT purchase_cost or vendor — an employee has no
 * business seeing what the company paid, and including it would make this
 * endpoint a way to read procurement figures.
 */
export async function listMyAssets({ orgId, userUuid }) {
  const employee = await employeeForUser(orgId, userUuid);
  // A sub-admin or org admin with no employee record simply has no assets. Not
  // an error, and worth not treating as one: the employee portal renders for
  // every org user.
  if (!employee) return [];

  const [rows] = await pool.query(
    `SELECT a.uuid, a.asset_tag, a.name, a.model_details, a.serial_number,
            a.warranty_expires_at, g.assigned_at, g.uuid AS assignment_uuid
       FROM asset_assignments g
       JOIN assets a ON a.uuid = g.asset_uuid
      WHERE g.employee_uuid=? AND g.organization_id=? AND g.returned_at IS NULL
        AND a.status = 'assigned'
      ORDER BY g.assigned_at DESC`,
    [employee.uuid, orgId],
  );

  return rows.map((r) => ({
    uuid: r.uuid,
    assignment_uuid: r.assignment_uuid,
    asset_tag: r.asset_tag,
    name: r.name,
    model_details: r.model_details,
    serial_number: r.serial_number,
    warranty_expires_at: r.warranty_expires_at,
    assigned_at: r.assigned_at,
  }));
}

// ---------------------------------------------------------------------------
// Attachments: purchase receipts
// ---------------------------------------------------------------------------

/**
 * Attach a purchase receipt to an asset.
 *
 * The entity is verified to exist in THIS org before any file row is written.
 * attachments.entity_uuid carries no foreign key — it points at a different table
 * per entity_type — so nothing but this check stops an attachment being attached
 * to another organization's asset. Without it, uploading a "receipt" against a
 * guessed uuid would create a row that only fails much later, if at all.
 */
export async function attachReceipt({ orgId, actorUuid, assetUuid, files, category, description }) {
  await loadAsset(orgId, assetUuid);
  const rows = await attachments.createAttachments({
    orgId,
    entityType: ATTACHMENT_ENTITY.ASSET,
    entityUuid: assetUuid,
    uploadedByUuid: actorUuid ?? null,
    category: category ?? ATTACHMENT_CATEGORY.RECEIPT,
    description: description ?? null,
    files,
  });
  audit(actorUuid, "asset.attachment.add", "asset", assetUuid, orgId, {
    count: rows.length,
    category: category ?? ATTACHMENT_CATEGORY.RECEIPT,
  });
  return rows;
}

export function listReceipts({ orgId, assetUuid }) {
  return attachments.listAttachments({
    orgId,
    entityType: ATTACHMENT_ENTITY.ASSET,
    entityUuid: assetUuid,
  });
}

/**
 * Soft-delete one of the entity's attachments.
 *
 * removeAttachment scopes by organization_id AND re-reads which entity owns the
 * file, so a caller cannot delete another organization's file even holding a
 * valid uuid. It does not itself confirm the file belongs to THIS asset, so the
 * check is made here before delegating: without it, a sub-admin with any
 * attachment uuid could strip a receipt off an asset they cannot see.
 */
export async function removeAssetAttachment({ orgId, actorUuid, attachmentUuid }) {
  const [rows] = await pool.query(
    `SELECT uuid, entity_type, entity_uuid FROM attachments
      WHERE uuid=? AND organization_id=? AND deleted_at IS NULL`,
    [attachmentUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Attachment not found");
  if (rows[0].entity_type !== ATTACHMENT_ENTITY.ASSET) {
    throw new ApiError(400, "That file does not belong to an asset");
  }
  await loadAsset(orgId, rows[0].entity_uuid);
  return attachments.removeAttachment({ orgId, attachmentUuid, actorUuid });
}

/** Stream an attachment, resolved through the shared path-traversal guard. */
export function resolveAssetAttachment({ orgId, attachmentUuid }) {
  return attachments.resolveForDownload({ orgId, attachmentUuid });
}

// ---------------------------------------------------------------------------
// Retirement (scrapping)
// ---------------------------------------------------------------------------

/**
 * Scrapping an asset. Retired assets remain in the register for audit history.
 * Refuses while the asset is assigned, since scrapping equipment an employee is
 * using would make the custody history contradict the asset record.
 */
export async function retireAsset({ orgId, actorUuid, assetUuid, reason }) {
  assertUuid(assetUuid, "Asset UUID");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const asset = await loadAsset(orgId, assetUuid, conn, true);

    if (asset.status === "retired") throw new ApiError(409, "This asset is already retired");
    if (asset.status === "assigned") {
      throw new ApiError(409, "Return this asset before retiring it");
    }

    await conn.query(
      "UPDATE assets SET status='retired', notes=? WHERE uuid=? AND organization_id=?",
      [
        reason ? `${asset.notes ? `${asset.notes}\n\n` : ""}Retired: ${reason}` : asset.notes,
        assetUuid,
        orgId,
      ],
    );
    await conn.commit();

    audit(actorUuid, "asset.retire", "asset", assetUuid, orgId, { reason: reason ?? null });
    return { status: "retired" };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Restore a scrapped asset. The one escape hatch from the terminal state. */
export async function reinstateAsset({ orgId, actorUuid, assetUuid }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await loadAsset(orgId, assetUuid, conn, true);
    const status = await syncStatus(conn, orgId, assetUuid);
    await conn.query(
      "UPDATE assets SET status=? WHERE uuid=? AND organization_id=?",
      [status, assetUuid, orgId],
    );
    await conn.commit();
    audit(actorUuid, "asset.reinstate", "asset", assetUuid, orgId, { status });
    return { status };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** Summary counts for the inventory dashboard tiles. */
export async function assetSummary({ orgId, scopeFilter, creatorScopeFilter }) {
  const visibleByAssignment = scopeFilter
    ? `EXISTS (SELECT 1 FROM asset_assignments sf JOIN employees e ON e.uuid=sf.employee_uuid WHERE sf.asset_uuid=assets.uuid AND sf.organization_id=assets.organization_id AND sf.returned_at IS NULL AND ${scopeFilter.sql})`
    : "0=1";
  const visibleByCreator = creatorScopeFilter ? creatorScopeFilter.sql.replace(/\ba\./g, "assets.") : "0=1";
  const scopeSql = scopeFilter || creatorScopeFilter ? ` AND (${visibleByAssignment} OR ${visibleByCreator})` : "";
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(purchase_cost),0) AS value
       FROM assets WHERE organization_id=?${scopeSql} GROUP BY status`,
    [orgId, ...(scopeFilter?.params ?? []), ...(creatorScopeFilter?.params ?? [])],
  );
  const byStatus = Object.fromEntries(ASSET_STATUSES.map((s) => [s, 0]));
  let totalValue = 0;
  for (const r of rows) {
    byStatus[r.status] = r.n;
    if (r.status !== "retired") totalValue += Number(r.value);
  }
  return { by_status: byStatus, total_value: totalValue };
}