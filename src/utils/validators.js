import { z } from "zod";
import ApiError from "./ApiError.js";

/**
 * Reusable zod schemas.
 *
 * Deliberately SHARED between the request layer and (where relevant) the domain
 * layer, so a value validated on the way in is the same value the business logic
 * reasons about. Each schema carries the rule it enforces as a message, because
 * the message is what the user sees — "must be 13 digits" beats "Invalid string".
 *
 * This file is intentionally small. It holds shapes used by more than one
 * module. A schema only one controller needs belongs next to that controller.
 */

/**
 * Pakistani CNIC: exactly 13 digits, conventionally ddddd-ddddddd-d where the
 * first digit encodes the province.
 *
 * Shape-only. Whether the digits form a REAL, issued CNIC is NADRA's business,
 * and pretending to validate that locally produces false rejections on valid
 * numbers.
 */
export const cnicSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ""))
  .refine((v) => /^\d{13}$/.test(v), "CNIC must be 13 digits");

/**
 * Phone: digits, spaces and the leading +. Kept deliberately permissive about
 * length — Pakistani mobile numbers vary by carrier and a strict rule here only
 * ever rejects valid customers.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9\s-]{7,20}$/, "must be a valid phone number");

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("must be a valid email address");

/**
 * Non-negative money, 2 decimals. MySQL DECIMAL(14,2) cannot hold negatives.
 *
 * The blank/null handling is in a preprocess step rather than the union,
 * because `z.union([z.number(), z.string()])` rejects null and undefined BEFORE
 * any downstream transform runs — a transform written as
 * `(v === null ? 0 : Number(v))` is unreachable dead code inside a union.
 */
export const moneySchema = z.preprocess(
  (v) => (v === "" || v === null ? 0 : v),
  z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n), "must be a number")
    .refine((n) => n >= 0, "must not be negative")
    .refine((n) => Math.abs(n) < 1e12, "is too large")
    .transform((n) => Math.round(n * 100) / 100)
);

/** A count that may legitimately be fractional — piece-work quantities. */
export const quantitySchema = z.preprocess(
  (v) => (v === "" || v === null ? 0 : v),
  z
    .union([z.number(), z.string()])
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n), "must be a number")
    .refine((n) => n >= 0, "must not be negative")
    .refine((n) => Math.abs(n) < 1e9, "is too large")
    .transform((n) => Math.round(n * 1000) / 1000)
);

/** Latitude in decimal degrees. */
export const latitudeSchema = z.coerce
  .number()
  .min(-90, "latitude must be between -90 and 90")
  .max(90, "latitude must be between -90 and 90");

/** Longitude in decimal degrees. */
export const longitudeSchema = z.coerce
  .number()
  .min(-180, "longitude must be between -180 and 180")
  .max(180, "longitude must be between -180 and 180");

/** Great-circle distance in metres — used by geofence checks. */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Parse with a zod schema and throw the project's own ApiError.
 *
 * The default zod error is a nested issue array that errorHandler does not
 * render usefully, so every caller would otherwise have to re-derive a message.
 * This keeps one shape on the wire: { statusCode: 400, message }.
 */
export function parseOrThrow(schema, input, label = "input") {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const path = first.path.join(".");
  throw new ApiError(400, `${path || label}: ${first.message}`);
}

/** A trimmed, non-empty name-like string. */
export const nameSchema = z.string().trim().min(1, "is required").max(150);

/** A trimmed, non-empty code-like string (department codes, job codes). */
export const codeSchema = z
  .string()
  .trim()
  .min(1, "is required")
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, "may contain letters, digits, dot, underscore and hyphen");

/** Free-text notes, normalised from "" to null so the column stays clean. */
export const notesSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional();