/**
 * Error codes the API returns so the frontend can tell apart failure modes that
 * used to be indistinguishable, both of which arrive as a 403:
 *
 *   SUBSCRIPTION_INACTIVE - the organization has no valid subscription at all.
 *                           Every org is always on a plan (Free by default), so
 *                           this is now a safety net for a corrupted or lapsed
 *                           state rather than a normal-path outcome.
 *   UPGRADE_REQUIRED     - the subscription is perfectly valid, the current
 *                           plan simply does not include this module. Retrying
 *                           or contacting an admin will not help; the org needs
 *                           a different plan.
 *
 * The distinction matters because the two need completely different UI: a
 * "contact your admin" banner versus an "upgrade to unlock this" prompt that
 * can open the plan chooser directly.
 */
export const ERROR_CODES = {
  SUBSCRIPTION_INACTIVE: "SUBSCRIPTION_INACTIVE",
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
};

export default class ApiError extends Error {
  /**
   * @param statusCode HTTP status
   * @param message    human-readable message
   * @param options    { code, ...extra } -- `code` is surfaced to the client and
   *                   `extra` is merged into the JSON body (e.g. `module`).
   */
  constructor(statusCode, message, options = {}) {
    super(message);
    this.statusCode = statusCode;
    const { code, ...extra } = options || {};
    if (code) this.code = code;
    if (extra && Object.keys(extra).length) this.extra = extra;
  }
}
