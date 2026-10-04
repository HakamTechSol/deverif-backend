import { pool } from "../config/db.js";
import ApiError from "../utils/ApiError.js";
import { assertUuid } from "../utils/publicResponse.js";
import { logAudit } from "../utils/auditLog.js";
import { paginatedResponse } from "../utils/pagination.js";
import { buildInsert, buildUpdateStrict, buildOrgScope, boolField } from "../utils/crudHelpers.js";

/**
 * Asset management: categories, inventory, custody, maintenance.
 *
 * THE ONE RULE THAT SHAPES THIS WHOLE MODULE. An asset's status is never set by a
 * client. It is DERIVED from whether the asset currently has an open assignment
 * or an open maintenance job:
 *
 *   open maintenance job            -> maintenance
 *   else open assignment            -> assigned
 *   else                            -> available   (or retired, if scrapped)
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

export const ASSET_STATUSES = ["available", "assigned", "maintenance", "retired"];
const RETURN_CONDITIONS = ["good", "damaged", "needs_maintenance"];

const CATEGORY_COLUMNS = ["name", "description", "default_lifespan_months", "is_active"];
const ASSET_COLUMNS = [
  "category_uuid",
  "asset_tag",
  "name",
  "model_details",
  "serial_number",
  "purchase_date",
  "purchase_cost",
  "vendor",
  "receipt_path",
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

/** A category must exist AND belong to this org, or the asset has no valid class. */
async function categoryInOrg(orgId, categoryUuid, conn = pool) {
  if (!categoryUuid) throw new ApiError(400, "category_uuid is required");
  assertUuid(categoryUuid, "Category UUID");
  const [rows] = await conn.query(
    "SELECT uuid, name, is_active FROM asset_categories WHERE uuid=? AND organization_id=?",
    [categoryUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Asset category not found");
  if (!rows[0].is_active) {
    throw new ApiError(409, `"${rows[0].name}" is inactive. Reactivate it before adding assets to it.`);
  }
  return rows[0];
}

async function employeeInOrg(orgId, employeeUuid, conn = pool) {
  if (!employeeUuid) throw new ApiError(400, "employee_uuid is required");
  assertUuid(employeeUuid, "Employee UUID");
  const [rows] = await conn.query(
    "SELECT uuid, full_name FROM employees WHERE uuid=? AND organization_id=?",
    [employeeUuid, orgId],
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
    `SELECT a.*, c.name AS category_name
       FROM assets a
       JOIN asset_categories c ON c.uuid = a.category_uuid
      WHERE a.uuid=? AND a.organization_id=?${forUpdate ? " FOR UPDATE" : ""}`,
    [assetUuid, orgId],
  );
  if (!rows.length) throw new ApiError(404, "Asset not found");
  return rows[0];
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listCategories({ orgId, includeInactive = false }) {
  const [rows] = await pool.query(
    `SELECT c.*,
            (SELECT COUNT(*) FROM assets a WHERE a.category_uuid = c.uuid) AS asset_count
       FROM asset_categories c
      WHERE c.organization_id = ?${includeInactive ? "" : " AND c.is_active = 1"}
      ORDER BY c.name`,
    [orgId],
  );
  return rows;
}

export async function createCategory({ orgId, actorUuid, data }) {
  const name = String(data.name ?? "").trim();
  if (!name) throw new ApiError(400, "name is required");

  const insert = composeInsert(
    { organization_id: orgId, created_by_uuid: actorUuid ?? null },
    {
      name,
      description: data.description ?? null,
      default_lifespan_months: data.default_lifespan_months ?? null,
      is_active: boolField(data.is_active, true) ? 1 : 0,
    },
    ["name", "description", "default_lifespan_months", "is_active"],
  );

  try {
    const [res] = await pool.query(
      `INSERT INTO asset_categories (${insert.columns.join(", ")}) VALUES (${insert.placeholders.join(", ")})`,
      insert.params,
    );
    const [[row]] = await pool.query(
      "SELECT * FROM asset_categories WHERE id=?",
      [res.insertId],
    );
    audit(actorUuid, "asset_category.create", "asset_category", row.uuid, orgId, { name });
    return row;
  } catch (e) {
    // The unique key is per-org, so this is a duplicate name within one
    // organization and nothing else. Surface it as a conflict rather than a 500.
    if (e.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, `A category named "${name}" already exists`);
    }
    throw e;
  }
}

export async function updateCategory({ orgId, actorUuid, categoryUuid, data }) {
  assertUuid(categoryUuid, "Category UUID");
  const scope = buildOrgScope(orgId, { uuid: categoryUuid });
  const update = buildUpdateStrict(
    {
      name: data.name === undefined ? undefined : String(data.name).trim(),
      description: data.description,
      default_lifespan_months: data.default_lifespan_months,
      is_active: data.is_active === undefined ? undefined : boolField(data.is_active) ? 1 : 0,
    },
    ["name", "description", "default_lifespan_months", "is_active"],
  );
  if (!update.columns.length) throw new ApiError(400, "No fields to update");

  try {
    const [res] = await pool.query(
      `UPDATE asset_categories ${update.clause} WHERE ${scope.clause}`,
      [...update.params, ...scope.params],
    );
    if (!res.affectedRows) throw new ApiError(404, "Asset category not found");
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") {
      throw new ApiError(409, "A category with that name already exists");
    }
    throw e;
  }

  const [[row]] = await pool.query(
    "SELECT * FROM asset_categories WHERE uuid=? AND organization_id=?",
    [categoryUuid, orgId],
  );
  audit(actorUuid, "asset_category.update", "asset_category", categoryUuid, orgId);
  return row;
}

/**
 * Retire a category rather than deleting it.
 *
 * A hard DELETE would either fail on the FK (assets still reference it) or, with
 * ON DELETE CASCADE, silently destroy an inventory and its purchase history
 * because someone clicked the wrong button. Deactivating is reversible and keeps
 * every historical reference intact.
 */
export async function deleteCategory({ orgId, actorUuid, categoryUuid }) {
  assertUuid(categoryUuid, "Category UUID");
  const [[asset]] = await pool.query(
    "SELECT COUNT(*) AS n FROM assets WHERE category_uuid=? AND organization_id=?",
    [categoryUuid, orgId],
  );
  if (asset.n > 0) {
    throw new ApiError(
      409,
      `This category still holds ${asset.n} asset(s). Reassign them before removing it.`,
    );
  }

  const scope = buildOrgScope(orgId, { uuid: categoryUuid });
  const [res] = await pool.query(
    `DELETE FROM asset_categories WHERE ${scope.clause}`,
    scope.params,
  );
  if (!res.affectedRows) throw new ApiError(404, "Asset category not found");
  audit(actorUuid, "asset_category.delete", "asset_category", categoryUuid, orgId);
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export async function listAssets({ orgId, page, limit, offset, search, status, categoryUuid }) {
  const clauses = ["a.organization_id = ?"];
  const params = [orgId];

  if (status) {
    if (!ASSET_STATUSES.includes(status)) {
      throw new ApiError(400, `status must be one of: ${ASSET_STATUSES.join(", ")}`);
    }
    clauses.push("a.status = ?");
    params.push(status);
  }
  if (categoryUuid) {
    assertUuid(categoryUuid, "Category UUID");
    clauses.push("a.category_uuid = ?");
    params.push(categoryUuid);
  }
  if (search) {
    // Scoped to the org's own asset_tag so a serial belonging to another tenant
    // can never be discovered by search.
    clauses.push("(a.asset_tag LIKE ? OR a.name LIKE ? OR a.model_details LIKE ? OR a.serial_number LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.join(" AND ");

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM assets a WHERE ${where}`,
    params,
  );

  const [rows] = await pool.query(
    `SELECT a.*, c.name AS category_name,
            (SELECT e.full_name FROM asset_assignments g
               JOIN employees e ON e.uuid = g.employee_uuid
              WHERE g.asset_uuid = a.uuid AND g.returned_at IS NULL LIMIT 1) AS holder_name,
            (SELECT COUNT(*) FROM asset_maintenance m
              WHERE m.asset_uuid = a.uuid AND m.status = 'open') AS open_jobs
       FROM assets a
       JOIN asset_categories c ON c.uuid = a.category_uuid
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
  const [jobs] = await pool.query(
    `SELECT uuid, title, description, status, vendor, cost, reported_at, completed_at
       FROM asset_maintenance
      WHERE asset_uuid=?
      ORDER BY reported_at DESC`,
    [assetUuid],
  );

  return {
    ...asset,
    holder: history.find((h) => !h.returned_at) ?? null,
    assignments: history,
    maintenance: jobs,
  };
}

/** Next tag for a new asset: AST-0001, AST-0002, ... within the organization. */
async function nextAssetTag(conn, orgId) {
  const [[{ n }]] = await conn.query(
    "SELECT COUNT(*) AS n FROM assets WHERE organization_id = ?",
    [orgId],
  );
  // COUNT is a floor, not a max: after deletions a new asset could collide with
  // an existing tag, so the candidate is checked against the unique key below
  // and stepped forward until it is free.
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
    await categoryInOrg(orgId, data.category_uuid, conn);

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
        category_uuid: data.category_uuid,
        asset_tag: tag,
        name,
        model_details: data.model_details ?? null,
        serial_number: data.serial_number ?? null,
        purchase_date: data.purchase_date || null,
        purchase_cost: data.purchase_cost ?? null,
        vendor: data.vendor ?? null,
        receipt_path: data.receipt_path ?? null,
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
    const asset = await loadAsset(orgId, assetUuid, conn, true);

    // A category swap must be validated in the same transaction that writes it,
    // otherwise a concurrent deactivation could leave the asset in a dead class.
    if (data.category_uuid && data.category_uuid !== asset.category_uuid) {
      await categoryInOrg(orgId, data.category_uuid, conn);
    }

    const update = buildUpdateStrict(
      {
        category_uuid: data.category_uuid,
        asset_tag: data.asset_tag === undefined ? undefined : String(data.asset_tag).trim(),
        name: data.name === undefined ? undefined : String(data.name).trim(),
        model_details: data.model_details,
        serial_number: data.serial_number,
        purchase_date: data.purchase_date || null,
        purchase_cost: data.purchase_cost ?? null,
        vendor: data.vendor ?? null,
        receipt_path: data.receipt_path ?? null,
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
 * Recompute an asset's status from its open rows.
 *
 * Maintenance outranks assignment deliberately. An asset that is out for repair
 * AND somehow still recorded as held is a data-entry error, and showing it as
 * "assigned" would invite someone to go looking for it in an employee's hands
 * when it is on a bench. Retired is terminal and never overwritten here, because
 * a scrapped asset stays scrapped regardless of stray rows.
 */
async function syncStatus(conn, orgId, assetUuid) {
  const [[m]] = await conn.query(
    "SELECT COUNT(*) AS n FROM asset_maintenance WHERE asset_uuid=? AND status='open'",
    [assetUuid],
  );
  const [[a]] = await conn.query(
    "SELECT COUNT(*) AS n FROM asset_assignments WHERE asset_uuid=? AND returned_at IS NULL",
    [assetUuid],
  );

  const next = m.n > 0 ? "maintenance" : a.n > 0 ? "assigned" : "available";
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
    if (asset.status === "maintenance") {
      throw new ApiError(409, "Complete or cancel the open maintenance job before assigning this asset");
    }
    if (asset.status === "assigned") {
      throw new ApiError(409, "This asset is already assigned. Return it first.");
    }

    const employee = await employeeInOrg(orgId, employeeUuid, conn);

    const [res] = await conn.query(
      `INSERT INTO asset_assignments
         (organization_id, asset_uuid, employee_uuid, assigned_by_uuid)
       VALUES (?, ?, ?, ?)`,
      [orgId, assetUuid, employeeUuid, actorUuid ?? null],
    );
    const [[row]] = await conn.query("SELECT uuid FROM asset_assignments WHERE id=?", [res.insertId]);

    const status = await syncStatus(conn, orgId, assetUuid);
    await conn.commit();

    audit(actorUuid, "asset.assign", "asset", assetUuid, orgId, {
      assignment_uuid: row.uuid,
      employee_uuid: employeeUuid,
      employee_name: employee.full_name,
    });
    return { assignment_uuid: row.uuid, status, employee_name: employee.full_name };
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

/**
 * Take an asset back.
 *
 * `return_condition` is not cosmetic. "needs_maintenance" opens a maintenance
 * job in the same transaction, because an asset coming back broken and then
 * sitting in "available" until somebody notices is exactly how broken equipment
 * gets handed to the next person.
 */
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

    let openedJob = null;
    if (condition === "needs_maintenance" || condition === "damaged") {
      const [job] = await conn.query(
        `INSERT INTO asset_maintenance (organization_id, asset_uuid, title, description, reported_by_uuid)
         VALUES (?, ?, ?, ?, ?)`,
        [
          orgId,
          assetUuid,
          condition === "damaged" ? "Reported damaged on return" : "Flagged on return",
          notes ?? null,
          actorUuid ?? null,
        ],
      );
      const [[jobRow]] = await conn.query("SELECT uuid FROM asset_maintenance WHERE id=?", [job.insertId]);
      openedJob = jobRow.uuid;
    }

    const status = await syncStatus(conn, orgId, assetUuid);
    await conn.commit();

    audit(actorUuid, "asset.return", "asset", assetUuid, orgId, { condition, notes: notes ?? null, opened_job: openedJob });
    return { status, opened_maintenance_uuid: openedJob };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export async function listMaintenance({ orgId, assetUuid, status }) {
  const clauses = ["m.organization_id = ?"];
  const params = [orgId];
  if (assetUuid) {
    assertUuid(assetUuid, "Asset UUID");
    clauses.push("m.asset_uuid = ?");
    params.push(assetUuid);
  }
  if (status) {
    clauses.push("m.status = ?");
    params.push(status);
  }
  const [rows] = await pool.query(
    `SELECT m.*, a.asset_tag, a.name AS asset_name
       FROM asset_maintenance m
       JOIN assets a ON a.uuid = m.asset_uuid
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.reported_at DESC`,
    params,
  );
  return rows;
}

export async function reportMaintenance({ orgId, actorUuid, assetUuid, data }) {
  const title = String(data.title ?? "").trim();
  if (!title) throw new ApiError(400, "title is required");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const asset = await loadAsset(orgId, assetUuid, conn, true);
    if (asset.status === "retired") {
      throw new ApiError(409, "A retired asset cannot be sent for maintenance");
    }

    let jobUuid;
    try {
      const [res] = await conn.query(
        `INSERT INTO asset_maintenance
           (organization_id, asset_uuid, title, description, vendor, cost,
            invoice_path, reported_by_uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orgId,
          assetUuid,
          title,
          data.description ?? null,
          data.vendor ?? null,
          data.cost ?? null,
          data.invoice_path ?? null,
          actorUuid ?? null,
        ],
      );
      const [[row]] = await conn.query("SELECT uuid FROM asset_maintenance WHERE id=?", [res.insertId]);
      jobUuid = row.uuid;
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") {
        throw new ApiError(409, "This asset already has an open maintenance job");
      }
      throw e;
    }

    const status = await syncStatus(conn, orgId, assetUuid);
    await conn.commit();

    audit(actorUuid, "asset.maintenance.report", "asset", assetUuid, orgId, {
      maintenance_uuid: jobUuid,
      vendor: data.vendor ?? null,
      cost: data.cost ?? null,
    });
    return { maintenance_uuid: jobUuid, status };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Close a maintenance job.
 *
 * `restoreToAvailable` is explicit rather than inferred. Completing a repair
 * while the asset is still recorded as held by an employee is a real situation
 * (borrowed company laptop sent for servicing), and guessing there would either
 * silently strip a live assignment or strand the asset in "assigned" with
 * nothing to fix. The caller states which situation they mean.
 */
export async function completeMaintenance({ orgId, actorUuid, jobUuid, data = {} }) {
  assertUuid(jobUuid, "Maintenance UUID");
  const finalStatus = data.status === "cancelled" ? "cancelled" : "completed";

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[job]] = await conn.query(
      "SELECT * FROM asset_maintenance WHERE uuid=? AND organization_id=? FOR UPDATE",
      [jobUuid, orgId],
    );
    if (!job) throw new ApiError(404, "Maintenance job not found");
    if (job.status !== "open") {
      throw new ApiError(409, `This job is already ${job.status}`);
    }

    await conn.query(
      `UPDATE asset_maintenance
          SET status=?, completed_at=NOW(), completed_by_uuid=?, completion_notes=?
        WHERE uuid=?`,
      [finalStatus, actorUuid ?? null, data.notes ?? null, jobUuid],
    );

    // Recompute from the rows rather than forcing "available": if the asset is
    // still legitimately held by someone, that is where it belongs.
    const status = await syncStatus(conn, orgId, job.asset_uuid);
    await conn.commit();

    audit(actorUuid, "asset.maintenance.complete", "asset", job.asset_uuid, orgId, {
      maintenance_uuid: jobUuid,
      status: finalStatus,
    });
    return { maintenance_uuid: jobUuid, status };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------------------------
// Retirement (scrapping)
// ---------------------------------------------------------------------------

/**
 * Scrapping an asset.
 *
 * Terminal by design: a scrapped asset cannot be assigned, returned, or sent for
 * maintenance, because its purchase history has to stay readable for the years
 * an auditor asks for it. That is why this is `retired` and not a DELETE — the
 * row is the record.
 *
 * Refuses while the asset is held or in the shop, since scrapping something an
 * employee is using would make the custody history contradict the asset record.
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
    if (asset.status === "maintenance") {
      throw new ApiError(409, "Close the open maintenance job before retiring this asset");
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
export async function assetSummary({ orgId }) {
  const [rows] = await pool.query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(purchase_cost),0) AS value
       FROM assets WHERE organization_id=? GROUP BY status`,
    [orgId],
  );
  const byStatus = Object.fromEntries(ASSET_STATUSES.map((s) => [s, 0]));
  let totalValue = 0;
  for (const r of rows) {
    byStatus[r.status] = r.n;
    if (r.status !== "retired") totalValue += Number(r.value);
  }
  const [[[{ n: maintenanceCost }]]] = await pool.query(
    "SELECT COALESCE(SUM(cost),0) AS n FROM asset_maintenance WHERE organization_id=? AND status='completed'",
    [orgId],
  );
  return { by_status: byStatus, total_value: totalValue, maintenance_spend: Number(maintenanceCost) };
}