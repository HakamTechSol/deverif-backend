import ApiError from "../../utils/ApiError.js";
import { pool } from "../../config/db.js";
import { ok, created } from "../../utils/response.js";
import { assertUuid } from "../../utils/publicResponse.js";
import { parsePagination, paginatedResponse } from "../../utils/pagination.js";
import { sendExpiryReminderEmail } from "../../utils/mailer.js";
import { createNotificationForOrgUsers } from "../notification.controller.js";

const ORG_SELECT = `id, uuid, name, verified, logo, organization_type,
  subscription_status, subscription_start, subscription_expiry, subscription_plan, reminder_2d_sent, reminder_2h_sent, created_at`;

export async function listOrganizations(req, res) {
  const { page, limit, offset } = parsePagination(req.query);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";

  let whereClause = "";
  const params = [];

  if (search) {
    whereClause = `WHERE name LIKE ? OR organization_type LIKE ?`;
    const like = `%${search}%`;
    params.push(like, like);
  }

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM organizations ${whereClause}`, params);
  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

  await Promise.all(rows.map(expireIfNeeded));

  // Lazy check for expiry reminders (runs on every admin org list request)
  checkAndSendExpiryReminders().catch(() => {});

  return ok(res, paginatedResponse(rows, total, page, limit), "Organizations list");
}

async function expireIfNeeded(org) {
  if (org.subscription_status === "active" && org.subscription_expiry && new Date(org.subscription_expiry) < new Date()) {
    org.subscription_status = "expired";
    await pool.query("UPDATE organizations SET subscription_status='expired' WHERE id=?", [org.id]);
  }
}

export async function assertOrganizationActive(orgId) {
  const [[org]] = await pool.query("SELECT subscription_status, subscription_expiry FROM organizations WHERE id=?", [orgId]);
  if (!org) return;
  await expireIfNeeded(org);
  if (org.subscription_status !== "active") {
    throw new ApiError(403, "Organization subscription is inactive. Please contact admin to renew.");
  }
}

export async function createOrganization(req, res) {
  const { name, organization_type } = req.body;
  if (!name) throw new ApiError(400, "name is required");

  const logoPath = req.file ? `uploads/organizations/${req.file.filename}` : null;

  const [result] = await pool.query(
    "INSERT INTO organizations (name, verified, logo, organization_type) VALUES (?, 'yes', ?, ?)",
    [name, logoPath, organization_type || null]
  );

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations WHERE id=?`, [result.insertId]);
  return created(res, { organization: rows[0] }, "Organization created");
}

export async function updateOrganization(req, res) {
  const { uuid } = req.params;
  const { name, organization_type } = req.body;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (organization_type !== undefined) updates.organization_type = organization_type;
  if (req.file) updates.logo = `uploads/organizations/${req.file.filename}`;

  if (!Object.keys(updates).length) throw new ApiError(400, "At least one field is required to update");

  const fields = Object.keys(updates).map((k) => `${k}=?`).join(", ");
  const values = Object.values(updates);

  await pool.query(`UPDATE organizations SET ${fields} WHERE uuid=?`, [...values, uuid]);

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations WHERE uuid=?`, [uuid]);
  return ok(res, { organization: rows[0] }, "Organization updated successfully");
}

export async function deleteOrganization(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  await pool.query("DELETE FROM organizations WHERE uuid=?", [uuid]);
  return ok(res, {}, "Organization deleted successfully");
}

export async function setOrganizationSubscription(req, res) {
  const { uuid } = req.params;
  const { plan, amount } = req.body;
  assertUuid(uuid, "Organization UUID");

  if (!["monthly", "yearly"].includes(plan)) {
    throw new ApiError(400, "plan must be 'monthly' or 'yearly'");
  }

  const [orgExists] = await pool.query("SELECT id, uuid FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  const orgId = orgExists[0].id;
  const now = new Date();
  const durationMonths = plan === "yearly" ? 12 : 1;
  const expiry = new Date(now);
  expiry.setMonth(expiry.getMonth() + durationMonths);

  await pool.query(
    `UPDATE organizations SET subscription_status='active', subscription_start=?, subscription_expiry=?, subscription_plan=?, reminder_2d_sent='no', reminder_2h_sent='no' WHERE id=?`,
    [now, expiry, plan, orgId]
  );

  // Record payment only if an amount was provided
  const numericAmount = Number(amount);
  if (numericAmount > 0) {
    const [[firstUser]] = await pool.query(
      "SELECT id FROM users WHERE organization=? ORDER BY created_at ASC LIMIT 1",
      [orgId]
    );
    if (firstUser) {
      await pool.query(
        `INSERT INTO payment (user_id, amount, payment_method, transaction_reference, paid_at, purpose) VALUES (?, ?, 'manual', ?, NOW(), ?)`,
        [firstUser.id, numericAmount, `SUB-${plan.toUpperCase()}-${Date.now()}`, `Subscription: ${plan} for organization`]
      );
    }
  }

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations WHERE uuid=?`, [uuid]);
  return ok(res, { organization: rows[0] }, `Subscription set to ${plan} (expires ${expiry.toISOString().slice(0, 10)})`);
}

export async function cancelOrganizationSubscription(req, res) {
  const { uuid } = req.params;
  assertUuid(uuid, "Organization UUID");

  const [orgExists] = await pool.query("SELECT id FROM organizations WHERE uuid=?", [uuid]);
  if (!orgExists.length) throw new ApiError(404, "Organization not found");

  await pool.query(
    `UPDATE organizations SET subscription_status='none', subscription_start=NULL, subscription_expiry=NULL, subscription_plan=NULL WHERE id=?`,
    [orgExists[0].id]
  );

  const [rows] = await pool.query(`SELECT ${ORG_SELECT} FROM organizations WHERE uuid=?`, [uuid]);
  return ok(res, { organization: rows[0] }, "Subscription cancelled");
}

export async function checkAndSendExpiryReminders() {
  try {
    const [orgs] = await pool.query(
      `SELECT id, uuid, name, subscription_expiry, reminder_2d_sent, reminder_2h_sent
       FROM organizations WHERE subscription_status='active' AND subscription_expiry IS NOT NULL`
    );

    const now = new Date();

    for (const org of orgs) {
      const expiryDate = new Date(String(org.subscription_expiry).replace(" ", "T"));
      if (isNaN(expiryDate.getTime())) continue;

      const hoursLeft = (expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      // 2-hour reminder (checked first since it's more urgent)
      if (hoursLeft > 0 && hoursLeft <= 2 && org.reminder_2h_sent === "no") {
        await sendExpiryReminderEmail({
          orgName: org.name,
          hoursLeft: Math.round(hoursLeft),
          type: "2h",
        }).catch(() => {});

        await createNotificationForOrgUsers({
          orgId: org.id,
          type: "expiry_warning",
          title: "Subscription expiring very soon!",
          message: `Your organization's subscription expires in ${Math.round(hoursLeft)} hour(s). Contact admin to renew.`,
          link: "/payments",
        }).catch(() => {});

        await pool.query(
          "UPDATE organizations SET reminder_2h_sent='yes' WHERE id=?",
          [org.id]
        );
      }

      // 2-day reminder
      if (hoursLeft > 2 && hoursLeft <= 48 && org.reminder_2d_sent === "no") {
        const daysLeft = Math.ceil(hoursLeft / 24);
        await sendExpiryReminderEmail({
          orgName: org.name,
          daysLeft,
          type: "2d",
        }).catch(() => {});

        await createNotificationForOrgUsers({
          orgId: org.id,
          type: "expiry_warning",
          title: "Subscription expiring soon",
          message: `Your organization's subscription expires in ${daysLeft} day(s). Contact admin to renew.`,
          link: "/payments",
        }).catch(() => {});

        await pool.query(
          "UPDATE organizations SET reminder_2d_sent='yes' WHERE id=?",
          [org.id]
        );
      }
    }
  } catch (err) {
    console.error("Error checking expiry reminders:", err.message);
  }
}