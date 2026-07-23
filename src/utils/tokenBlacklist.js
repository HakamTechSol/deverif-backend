import crypto from "crypto";
import { pool } from "../config/db.js";

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function blacklistToken(token) {
  const decoded = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString()
  );
  const expiresAt = new Date(decoded.exp * 1000);
  await pool.query(
    "INSERT IGNORE INTO token_blacklist (token_hash, expires_at) VALUES (?, ?)",
    [tokenHash(token), expiresAt]
  );
}

export async function isBlacklisted(token) {
  const [rows] = await pool.query(
    "SELECT 1 FROM token_blacklist WHERE token_hash=? LIMIT 1",
    [tokenHash(token)]
  );
  return rows.length > 0;
}

export async function cleanupExpiredTokens() {
  await pool.query("DELETE FROM token_blacklist WHERE expires_at < NOW()");
}
