import multer from "multer";
import path from "path";
import { DOCS_DIR } from "../config/uploadPaths.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOCS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `doc_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

function fileFilter(req, file, cb) {
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
  const ext = path.extname(file.originalname || "").toLowerCase();
  // Accept by extension (reliable) or by a known mime; allow empty mime if ext matches.
  if (allowedExt.includes(ext) || (file.mimetype && allowedMime.includes(file.mimetype))) {
    return cb(null, true);
  }
  cb(new Error("Unsupported file type. Allowed: PDF, images, Word, Excel, TXT, CSV, ZIP"));
}

export const uploadDocs = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});