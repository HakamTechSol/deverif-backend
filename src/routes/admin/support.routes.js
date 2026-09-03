import { Router } from "express";
import asyncHandler from "../../utils/asyncHandler.js";
import authAdminEnv from "../../middleware/authAdminEnv.js";
import {
  listAdminTickets,
  getAdminTicket,
  addAdminReply,
  updateTicketStatus,
} from "../../controllers/support.controller.js";

const router = Router();

// System-admin side: cross-organization support triage, replies and status.
router.get("/", authAdminEnv, asyncHandler(listAdminTickets));

router.get("/:uuid", authAdminEnv, asyncHandler(getAdminTicket));
router.post("/:uuid/replies", authAdminEnv, asyncHandler(addAdminReply));
router.patch("/:uuid/status", authAdminEnv, asyncHandler(updateTicketStatus));

export default router;
