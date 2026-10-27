import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import {
  listOrgTickets,
  createTicket,
  getOrgTicket,
  addOrgReply,
  updateTicketStatus,
} from "../controllers/support.controller.js";

const router = Router();

// Org-side support. Employees and sub-admins raise tickets to their
// Organization Admin; org admins raise to the System Admin and also work their
// organization's inbound queue.
const orgUser = requireRole("org_admin", "sub_admin", "employee");
const orgAdmin = requireRole("org_admin");

router.get("/tickets", orgUser, asyncHandler(listOrgTickets));
router.post("/tickets", orgUser, asyncHandler(createTicket));

router.get("/tickets/:uuid", orgUser, asyncHandler(getOrgTicket));
router.post("/tickets/:uuid/replies", orgUser, asyncHandler(addOrgReply));
router.patch("/tickets/:uuid/status", orgAdmin, asyncHandler(updateTicketStatus));

export default router;
