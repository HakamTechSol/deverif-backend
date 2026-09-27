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
  const err = new Error("Unsupported file type. Allowed: PDF, images, Word (DOC/DOCX) or TXT");
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
 *
 * Archives and spreadsheets are deliberately NOT accepted, even though they are
 * real document formats a user might reasonably try to upload:
 *
 *   - A .docx IS a zip (OOXML is a zip container). So does that make .zip safe?
 *     No, and this is the subtle part. .docx is allowed *because of* the
 *     extension, and the Python validator then PROVES the container really is a
 *     Word document by requiring `[Content_Types].xml` and a `word/` entry
 *     inside the archive. A bare .zip has no such content, so allowing the
 *     extension would let through an arbitrary archive that can hold anything at
 *     all. The allow-list must name the document type, not the container.
 *   - .xlsx/.xls were accepted but Excel is not a supported document type here.
 *   - .csv is sniffed as plain text and accepted on magic alone, so it arrived
 *     with no parsing guarantee at all.
 *
 * The AND-check is what makes this robust against spoofing: an attacker who
 * labels a zip "application/pdf" still fails the extension check, and one who
 * names it "report.docx" is caught later by the OOXML part check. Neither half
 * is load-bearing on its own.
 */
export function isDocumentAllowed(filename, mimetype) {
  const allowedMime = [
    "application/pdf",
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
  ];
  const allowedExt = [
    ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp",
    ".doc", ".docx", ".txt",
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