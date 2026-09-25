import multer from "multer";
import path from "path";
import fs from "fs";
import { DOCS_DIR } from "../config/uploadPaths.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
    cb(null, DOCS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `doc_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  const ok = isDocumentAllowed(file.originalname, file.mimetype);
  if (ok) return cb(null, true);
  const err = new Error("Unsupported file type. Allowed: PDF, images, Word, Excel, TXT, CSV, ZIP");
  err.statusCode = 400;
  cb(err);
}

/**
 * Allow-list decision for verification-document uploads. Require BOTH a
 * recognized extension AND a plausible mime — a client can lie about either
 * one, so accepting on extension alone lets HTML/SVG through as
 * application/pdf, and accepting on mime alone lets x.html through as
 * application/pdf. Generic browser blob markers (application/octet-stream)
 * are tolerated only for allow-listed extensions.
 */
export function isDocumentAllowed(filename, mimetype) {
  const allowedMime = [
    "application/pdf",
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain", "text/csv",
    "application/zip",
  ];
  const allowedExt = [
    ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp",
    ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv", ".zip",
  ];
  const ext = path.extname(filename || "").toLowerCase();
  return allowedExt.includes(ext) && Boolean(mimetype) &&
    (allowedMime.includes(mimetype) || mimetype === "application/octet-stream");
}

export const uploadDocs = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});