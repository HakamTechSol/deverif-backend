import { Router } from "express";
import asyncHandler from "../utils/asyncHandler.js";
import authUser from "../middleware/authUser.js";
import { uploadDocs } from "../middleware/uploadDocs.js";
import { createRequestLimiter } from "../middleware/rateLimiter.js";

import {
  createRequest,
  mySentRequests,
  deleteMySentRequest,
  updateMySentRequest,
  myInboxRequests,
  myInboxCount,
  verifyRequest,
  listOrganizations
} from "../controllers/verification.controller.js";

const router = Router();

router.post("/", authUser, createRequestLimiter, uploadDocs.single("document"), asyncHandler(createRequest));
router.get("/organizations", authUser, asyncHandler(listOrganizations));
router.get("/my/sent", authUser, asyncHandler(mySentRequests));
router.put("/my/sent/:uuid", authUser, uploadDocs.single("document"), asyncHandler(updateMySentRequest));
router.delete("/my/sent/:uuid", authUser, asyncHandler(deleteMySentRequest));
router.get("/my/inbox", authUser, asyncHandler(myInboxRequests));
router.get("/my/inbox/count", authUser, asyncHandler(myInboxCount));
router.patch("/:uuid/verify", authUser, asyncHandler(verifyRequest));

export default router;