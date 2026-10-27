import multer from "multer";
import path from "path";
import fs from "fs";
import { ATTACHMENTS_DIR } from "../config/uploadPaths.js";
import { isDocumentAllowed } from "./uploadDocs.js";

/**
 * Uploader for entity attachments.
 *
 * Separate from `uploadDocs` because the DESTINATION differs, and that is not a
 * detail: attachments.service.js re-anchors every stored path against
 * ATTACHMENTS_DIR and rejects anything resolving outside it. A file written to
 * DOCS_DIR and stored as if it were under ATTACHMENTS_DIR would fail its own
 * traversal guard at download time — a confusing 400 long after the upload
 * appeared to succeed.
 *
 * The allow-list is deliberately isDocumentAllowed's, reused rather than
 * restated: a purchase receipt or a maintenance invoice is a document in exactly
 * the sense that function defines (PDF, images, Word, TXT), and a second,
 * looser allow-list for attachments would be a way to upload something the rest
 * of the system refuses.
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    cb(null, ATTACHMENTS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Original name is stored separately for display and never trusted on read,
    // so a randomised on-disk name costs nothing and removes any chance of the
    // upload's own name being used to traverse.
    cb(null, `att_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (isDocumentAllowed(file.originalname, file.mimetype)) return cb(null, true);
  const err = new Error("Unsupported file type. Allowed: PDF, images, Word (DOC/DOCX) or TXT");
  err.statusCode = 400;
  cb(err);
}

export const uploadAttachments = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
});