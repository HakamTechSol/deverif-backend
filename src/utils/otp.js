import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "../config/db.js";

const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = 5;
const MAX_ATTEMPTS = 5;

export function generateOtp() {
  const min = 10 ** (OTP_LENGTH - 1);
  const max = 10 ** OTP_LENGTH - 1;
  const buffer = crypto.randomBytes(4);
  const num = buffer.readUInt32BE(0);
  return String(min + (num % (max - min + 1))).padStart(OTP_LENGTH, "0");
}

export async function hashOtp(otp) {
  return bcrypt.hash(otp, 10);
}

export async function verifyOtpHash(otp, hash) {
  return bcrypt.compare(otp, hash);
}

export async function storeOtp({ identityType, identityId, otpHash }) {
  await pool.query(
    "UPDATE login_otps SET used_at = NOW() WHERE identity_type = ? AND identity_id = ? AND used_at IS NULL",
    [identityType, identityId]
  );

  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
  await pool.query(
    "INSERT INTO login_otps (identity_type, identity_id, otp_hash, attempts, expires_at) VALUES (?, ?, ?, 0, ?)",
    [identityType, identityId, otpHash, expiresAt]
  );
  return expiresAt;
}

export async function consumeOtp({ identityType, identityId, otp }) {
  const [rows] = await pool.query(
    "SELECT id, otp_hash, attempts, expires_at FROM login_otps WHERE identity_type = ? AND identity_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1",
    [identityType, identityId]
  );

  if (!rows.length) return { ok: false, reason: "no_otp" };

  const record = rows[0];

  if (new Date(record.expires_at) < new Date()) {
    await pool.query("UPDATE login_otps SET used_at = NOW() WHERE id = ?", [record.id]);
    return { ok: false, reason: "expired" };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await pool.query("UPDATE login_otps SET used_at = NOW() WHERE id = ?", [record.id]);
    return { ok: false, reason: "max_attempts" };
  }

  await pool.query("UPDATE login_otps SET attempts = attempts + 1 WHERE id = ?", [record.id]);

  const match = await verifyOtpHash(otp, record.otp_hash);
  if (!match) {
    return { ok: false, reason: "invalid", remaining: MAX_ATTEMPTS - (record.attempts + 1) };
  }

  await pool.query("UPDATE login_otps SET used_at = NOW() WHERE id = ?", [record.id]);
  return { ok: true };
}

export async function invalidateOtps(identityType, identityId) {
  await pool.query(
    "UPDATE login_otps SET used_at = NOW() WHERE identity_type = ? AND identity_id = ? AND used_at IS NULL",
    [identityType, identityId]
  );
}
