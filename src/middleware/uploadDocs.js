import multer from "multer";
import path from "path";
import fs from "fs";

const baseDir = process.env.UPLOAD_DIR || "uploads";
const docsDir = path.join(baseDir, "documents");

if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, docsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `doc_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  // As per your schema: pdf, jpeg
  const allowed = ["application/pdf", "image/jpeg"];
  if (!allowed.includes(file.mimetype)) return cb(new Error("Only PDF or JPEG allowed"));
  cb(null, true);
}

export const uploadDocs = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }
});
