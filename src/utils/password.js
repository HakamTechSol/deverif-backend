import bcrypt from "bcryptjs";
import ApiError from "./ApiError.js";

export const HASH_ROUNDS = 12;

const STRONG_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~])[A-Za-z\d!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]{8,}$/;

export function validatePasswordPolicy(password) {
  if (typeof password !== "string" || !STRONG_PASSWORD.test(password)) {
    throw new ApiError(
      400,
      "Password must be at least 8 characters and include uppercase, lowercase, number, and special character"
    );
  }
}

export function hashPassword(plain) {
  return bcrypt.hash(plain, HASH_ROUNDS);
}

export function comparePassword(plain, hashed) {
  return bcrypt.compare(plain, hashed);
}
