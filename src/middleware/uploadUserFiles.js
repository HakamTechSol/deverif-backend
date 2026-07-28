import multer from "multer";
import path from "path";
import fs from "fs";

const baseDir = process.env.UPLOAD_DIR || "uploads";
const profileDir = path.join(baseDir, "profiles");
const orgDir = path.join(baseDir, "organizations");

if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir, { recursive: true });
if (!fs.existsSync(orgDir)) fs.mkdirSync(orgDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, file.fieldname === "org_logo" ? orgDir : profileDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.fieldname === "org_logo") {
      cb(null, `org_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
    } else {
      cb(null, `profile_${Date.now()}${ext}`);
    }
  },
});

function fileFilter(req, file, cb) {
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml"];
  if (!allowed.includes(file.mimetype)) {
    return cb(new Error("Only image files allowed"));
  }
  cb(null, true);
}

export const uploadUserFiles = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});
