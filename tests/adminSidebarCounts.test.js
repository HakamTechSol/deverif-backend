import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config/db.js", () => ({ pool: { query: vi.fn() } }));

import { pool } from "../src/config/db.js";
import { getSidebarCounts } from "../src/controllers/admin/sidebar.controller.js";

const mockResponse = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn().mockReturnThis(),
});

describe("GET /admin/sidebar-counts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns awaiting-action counts using four COUNT queries", async () => {
    pool.query
      .mockResolvedValueOnce([[{ total: 7 }]])
      .mockResolvedValueOnce([[{ total: 4 }]])
      .mockResolvedValueOnce([[{ total: 2 }]])
      .mockResolvedValueOnce([[{ total: 3 }]]);
    const res = mockResponse();

    await getSidebarCounts({}, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json.mock.calls[0][0].data).toEqual({
      leads: 7,
      support_tickets: 4,
      custom_plan_requests: 2,
      unmatched_requests: 3,
    });
    expect(pool.query).toHaveBeenCalledTimes(4);
    expect(pool.query.mock.calls[0][0]).toContain("contact_leads WHERE status='new'");
    expect(pool.query.mock.calls[0][0]).toContain("access_requests WHERE status='new'");
    expect(pool.query.mock.calls[1][0]).toContain("t.status='open'");
    expect(pool.query.mock.calls[1][0]).toContain("r.replied_by_type='admin'");
    expect(pool.query.mock.calls[1][0]).toContain("r.replied_by_type='admin'");
    expect(pool.query.mock.calls[2][0]).toContain("status='pending'");
    expect(pool.query.mock.calls[3][0]).toContain("unmatched_organizations WHERE status='pending'");
  });
});
