import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BACKEND_ROOT = path.resolve(HERE, "..", "..");

export function resolveUploadRoot() {
  const configured = process.env.UPLOAD_DIR || "uploads";
  return path.isAbsolute(configured) ? configured : path.resolve(BACKEND_ROOT, configured);
}

export const UPLOAD_ROOT = resolveUploadRoot();
export const DOCS_DIR = path.join(UPLOAD_ROOT, "documents");
export const PROFILES_DIR = path.join(UPLOAD_ROOT, "profiles");
export const ORGS_DIR = path.join(UPLOAD_ROOT, "organizations");

export function ensureUploadDirs() {
  for (const dir of [UPLOAD_ROOT, DOCS_DIR, PROFILES_DIR, ORGS_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  return { UPLOAD_ROOT, DOCS_DIR, PROFILES_DIR, ORGS_DIR };
}