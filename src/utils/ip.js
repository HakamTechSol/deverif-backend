/**
 * Normalize an IP address for storage/display:
 * - IPv6-mapped IPv4 ("::ffff:203.0.113.5") → plain IPv4 ("203.0.113.5")
 * - trims whitespace; falls back to "unknown"
 */
export function normalizeIp(ip) {
  if (typeof ip !== "string" || !ip.trim()) return "unknown";
  const trimmed = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  if (mapped) return mapped[1];
  return trimmed;
}
