import multer from "multer";
import path from "path";
import fs from "fs";
import ApiError from "../utils/ApiError.js";
import { PROFILES_DIR } from "../config/uploadPaths.js";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
    cb(null, PROFILES_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `profile_${Date.now()}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  const allowed = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
  if (!allowed.includes(file.mimetype)) {
    return cb(new ApiError(400, "Profile image must be a PNG, JPG, JPEG, or WEBP image."));
  }
  cb(null, true);
}

export const uploadProfile = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }
});

export function uploadProfileImage(req, res, next) {
  uploadProfile.single("profile_image")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return next(new ApiError(413, "Profile image must be 2 MB or smaller."));
      }
      return next(new ApiError(400, "Profile image upload is invalid."));
    }
    return next(err);
  });
}