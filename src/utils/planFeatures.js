/**
 * Normalize a plan's `features` value into a canonical array of
 * `{ text, highlight }` objects.
 *
 * The `features` column is a JSON string. Historically it stored a plain
 * string array (e.g. `["Email support"]`). Newer data stores objects with an
 * optional `highlight` flag so the marketing site can render some features
 * boldly and others mutedly. This helper accepts all three representations:
 *
 *   - a JSON string (possibly `""` or `null`)
 *   - a legacy string array  -> each entry becomes `{ text, highlight: false }`
 *   - an object array of `{ text, highlight? }` (highlight optional)
 *
 * It also tolerates a plain comma-separated string ("a, b, c") for robustness.
 */
export function normalizePlanFeatures(raw) {
  let parsed = raw;
  if (!parsed) return [];

  if (typeof parsed === "string") {
    const trimmed = parsed.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Legacy comma-separated string
      parsed = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((f) => {
      if (typeof f === "string") {
        const text = f.trim();
        return text ? { text, highlight: false } : null;
      }
      if (f && typeof f === "object" && typeof f.text === "string") {
        const text = f.text.trim();
        if (!text) return null;
        return { text, highlight: Boolean(f.highlight) };
      }
      return null;
    })
    .filter(Boolean);
}