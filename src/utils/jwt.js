import jwt from "jsonwebtoken";
import ApiError from "./ApiError.js";

const ACCESS_TOKEN_EXPIRES_IN = "30m";
const ACCESS_TOKEN_MAX_SECONDS = 30 * 60;

const JWT_ISSUER = process.env.JWT_ISSUER || "dverif-api";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "dverif-client";

const REFRESH_ISSUER = process.env.JWT_ISSUER || "dverif-api";
const REFRESH_AUDIENCE = "dverif-refresh";
const REQUIRED_CLAIMS = ["userId", "role", "iat", "exp"];

export function getJwtSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_me") {
    throw new ApiError(500, "JWT secret is not configured");
  }
  return process.env.JWT_SECRET;
}

function getRefreshSecret() {
  if (!process.env.JWT_REFRESH_SECRET) {
    throw new ApiError(500, "JWT refresh secret is not configured");
  }
  return process.env.JWT_REFRESH_SECRET;
}

export function signAccessToken(payload) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: ACCESS_TOKEN_EXPIRES_IN,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithm: "HS256",
  });
}

export function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      algorithms: ["HS256"],
    });

    const missingClaim = REQUIRED_CLAIMS.some(
      (claim) => decoded[claim] === undefined || decoded[claim] === null
    );
    const invalidLifetime =
      typeof decoded.iat !== "number" ||
      typeof decoded.exp !== "number" ||
      decoded.exp <= decoded.iat ||
      decoded.exp - decoded.iat > ACCESS_TOKEN_MAX_SECONDS;

    if (missingClaim || invalidLifetime) {
      throw new ApiError(401, "Unauthorized");
    }

    return decoded;
  } catch (error) {
    if (error instanceof ApiError && error.statusCode !== 401) {
      throw error;
    }
    throw new ApiError(401, "Unauthorized");
  }
}

export function signRefreshToken(payload, rememberMe = false) {
  const expiresIn = rememberMe ? "30d" : "7d";
  return jwt.sign(payload, getRefreshSecret(), {
    expiresIn,
    issuer: REFRESH_ISSUER,
    audience: REFRESH_AUDIENCE,
    algorithm: "HS256",
  });
}

export function verifyRefreshToken(token) {
  try {
    return jwt.verify(token, getRefreshSecret(), {
      issuer: REFRESH_ISSUER,
      audience: REFRESH_AUDIENCE,
      algorithms: ["HS256"],
    });
  } catch {
    throw new ApiError(401, "Invalid or expired refresh token");
  }
}