import multer from "multer";
import path from "path";
import fs from "fs";
import { ORGS_DIR } from "../config/uploadPaths.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(ORGS_DIR)) fs.mkdirSync(ORGS_DIR, { recursive: true });
    cb(null, ORGS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `org_${Date.now()}_${Math.round(Math.random() * 1e9)}${ext}`);
  }
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

export const uploadOrganizationLogo = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});