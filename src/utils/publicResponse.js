const UUID_V4_OR_COMPATIBLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTERNAL_ID_KEYS = new Set(["id", "user_id", "issuing_organization_id", "verified_by"]);

export function isUuid(value) {
  return typeof value === "string" && UUID_V4_OR_COMPATIBLE.test(value);
}

export function assertUuid(value, label = "UUID") {
  if (!isUuid(value)) {
    const error = new Error(`${label} must be a valid UUID`);
    error.statusCode = 400;
    throw error;
  }
}

export function sanitizePublicData(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizePublicData(item));
  if (value instanceof Date) return value.toISOString();
  if (!value || typeof value !== "object") return value;

  const sanitized = {};
  for (const [key, itemValue] of Object.entries(value)) {
    if (INTERNAL_ID_KEYS.has(key)) continue;
    if (key === "organization" && typeof itemValue === "number") continue;
    sanitized[key] = sanitizePublicData(itemValue);
  }
  return sanitized;
}