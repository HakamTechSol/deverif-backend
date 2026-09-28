import { pool } from "../../config/db.js";
import { ok } from "../../utils/response.js";
import { OPEN_TICKET_NEEDS_ADMIN_REPLY } from "../../utils/supportTicketPredicates.js";

// These predicates match the admin lead, support, plan, and unmatched queues.
export async function getSidebarCounts(_req, res) {
  const [leads, tickets, customPlans, unmatched] = await Promise.all([
    pool.query(`SELECT
      (SELECT COUNT(*) FROM contact_leads WHERE status='new') +
      (SELECT COUNT(*) FROM access_requests WHERE status='new') AS total`),
    pool.query(`SELECT COUNT(*) AS total FROM support_tickets t WHERE t.status='open' AND ${OPEN_TICKET_NEEDS_ADMIN_REPLY}`),
    pool.query("SELECT COUNT(*) AS total FROM custom_plan_requests WHERE status='pending'"),
    pool.query("SELECT COUNT(*) AS total FROM unmatched_organizations WHERE status='pending'"),
  ]);

  return ok(res, {
    leads: Number(leads[0][0]?.total ?? 0),
    support_tickets: Number(tickets[0][0]?.total ?? 0),
    custom_plan_requests: Number(customPlans[0][0]?.total ?? 0),
    unmatched_requests: Number(unmatched[0][0]?.total ?? 0),
  }, "Admin sidebar counts");
}