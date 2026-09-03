/**
 * FRONTEND_*_URL env vars may contain a comma-separated list of allowed
 * frontend origins (e.g. "http://localhost:8080/x,http://localhost:8081").
 * Links embedded in emails must use exactly one base URL, so take the first.
 */
export function firstFrontendUrl(value, fallback) {
  const first = String(value || "")
    .split(",")[0]
    .trim();
  return first || fallback;
}
