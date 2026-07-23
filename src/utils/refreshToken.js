import crypto from "crypto";
import { pool } from "../config/db.js";

function tokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function storeRefreshToken({ token, type, identifier, expiresAt }) {
  await pool.query(
    "INSERT INTO refresh_tokens (token_hash, type, identifier, expires_at) VALUES (?, ?, ?, ?)",
    [tokenHash(token), type, identifier, expiresAt]
  );
}

export async function verifyRefreshToken({ token, type }) {
  const hash = tokenHash(token);
  const [rows] = await pool.query(
    "SELECT id, identifier, expires_at FROM refresh_tokens WHERE token_hash=? AND type=? LIMIT 1",
    [hash, type]
  );

  if (!rows.length) return null;

  const record = rows[0];
  if (new Date(record.expires_at) < new Date()) return null;

  return record;
}

export async function revokeRefreshToken(token) {
  await pool.query("DELETE FROM refresh_tokens WHERE token_hash=?", [tokenHash(token)]);
}

export async function revokeAllRefreshTokens(type, identifier) {
  await pool.query("DELETE FROM refresh_tokens WHERE type=? AND identifier=?", [type, identifier]);
}

export async function cleanupExpiredRefreshTokens() {
  await pool.query("DELETE FROM refresh_tokens WHERE expires_at < NOW()");
}
