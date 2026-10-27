import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authAny from "../middleware/authAny.js";
import {
  listTickets,
  getTicket,
  addReply,
  updateTicketStatus,
  createTicket,
} from "../controllers/support.controller.js";
import ApiError from "../utils/ApiError.js";

const router = Router();

function requireOrgUser(req, _res, next) {
  if (!req.user) {
    return next(new ApiError(403, "Only organization users can raise support tickets"));
  }
  next();
}

// Unified support endpoint. The controller applies the 2-tier visibility matrix:
//   employee/sub_admin -> own tickets only
//   org_admin          -> organization inbound + own outbound
//   system admin       -> tickets routed to the system_admin tier
router.get("/tickets", authAny, asyncHandler(listTickets));
router.post("/tickets", authAny, requireOrgUser, asyncHandler(createTicket));

router.get("/tickets/:uuid", authAny, asyncHandler(getTicket));
router.post("/tickets/:uuid/replies", authAny, asyncHandler(addReply));
router.patch("/tickets/:uuid/status", authAny, asyncHandler(updateTicketStatus));

export default router;
