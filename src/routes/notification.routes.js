import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from "../controllers/notification.controller.js";

const router = Router();

router.get("/", authUser, asyncHandler(listNotifications));
router.get("/unread-count", authUser, asyncHandler(unreadCount));
router.post("/:id/read", authUser, asyncHandler(markRead));
router.post("/read-all", authUser, asyncHandler(markAllRead));

export default router;
