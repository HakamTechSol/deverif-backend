import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import requireRole from "../middleware/requireRole.js";
import {
  listOrgTickets,
  createTicket,
  getOrgTicket,
  addOrgReply,
} from "../controllers/support.controller.js";

const router = Router();

// Org-side support: any organization user (org_admin / sub_admin / employee)
// can raise, view and reply to their organization's tickets.
const orgUser = requireRole("org_admin", "sub_admin", "employee");

router.get("/tickets", orgUser, asyncHandler(listOrgTickets));
router.post("/tickets", orgUser, asyncHandler(createTicket));

router.get("/tickets/:uuid", orgUser, asyncHandler(getOrgTicket));
router.post("/tickets/:uuid/replies", orgUser, asyncHandler(addOrgReply));

export default router;
