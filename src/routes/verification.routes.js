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
  getMyInboxRequestDetail,
  myAutoVerifiedRequests,
  getAutoVerifiedRequestHistory,
  verifyRequest,
  listOrganizations
} from "../controllers/verification.controller.js";
import { downloadCertificate } from "../controllers/certificate.controller.js";
import ApiError from "../utils/ApiError.js";
import { getDataScope } from "../utils/dataScopes.js";

const router = Router();

const requireOrganizationInboxScope = (req, res, next) => {
  if (getDataScope(req.user, "document_verification") !== "entire_organization") {
    return next(new ApiError(403, "Organization inbox access requires Entire Organization data scope."));
  }
  return next();
};

router.post("/", authUser, createRequestLimiter, uploadDocs.single("document"), asyncHandler(createRequest));
router.get("/organizations", authUser, asyncHandler(listOrganizations));
router.get("/my/sent", authUser, asyncHandler(mySentRequests));
router.put("/my/sent/:uuid", authUser, uploadDocs.single("document"), asyncHandler(updateMySentRequest));
router.delete("/my/sent/:uuid", authUser, asyncHandler(deleteMySentRequest));
router.get("/my/inbox", authUser, requireOrganizationInboxScope, asyncHandler(myInboxRequests));
router.get("/my/inbox/count", authUser, requireOrganizationInboxScope, asyncHandler(myInboxCount));
router.get("/my/inbox/:uuid", authUser, requireOrganizationInboxScope, asyncHandler(getMyInboxRequestDetail));
router.get("/my/auto-verified", authUser, requireOrganizationInboxScope, asyncHandler(myAutoVerifiedRequests));
router.get("/my/auto-verified/:uuid/history", authUser, requireOrganizationInboxScope, asyncHandler(getAutoVerifiedRequestHistory));
router.patch("/:uuid/verify", authUser, requireOrganizationInboxScope, asyncHandler(verifyRequest));
router.get("/:uuid/certificate", authUser, asyncHandler(downloadCertificate));

export default router;