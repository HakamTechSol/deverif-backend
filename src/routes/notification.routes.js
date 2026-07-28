import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
  markReadByReference,
} from "../controllers/notification.controller.js";

const router = Router();

router.get("/", authUser, asyncHandler(listNotifications));
router.get("/unread-count", authUser, asyncHandler(unreadCount));
router.post("/read-by-reference/:referenceId", authUser, asyncHandler(markReadByReference));
router.post("/:id/read", authUser, asyncHandler(markRead));
router.post("/read-all", authUser, asyncHandler(markAllRead));

export default router;
