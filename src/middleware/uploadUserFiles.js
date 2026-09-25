import multer from "multer";
import path from "path";
import fs from "fs";
import { PROFILES_DIR, ORGS_DIR } from "../config/uploadPaths.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = file.fieldname === "org_logo" ? ORGS_DIR : PROFILES_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
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
  const allowed = ["image/png", "image/jpeg", "image/jpg"];
  if (!allowed.includes(file.mimetype)) {
    const err = new Error("Only image files allowed");
    err.statusCode = 400;
    return cb(err);
  }
  cb(null, true);
}

export const uploadUserFiles = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});