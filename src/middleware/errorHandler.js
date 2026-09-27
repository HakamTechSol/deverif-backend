import ApiError from "../utils/ApiError.js";

export default function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError ? err.statusCode : (err.statusCode || 500);
  const message = err?.message || "Server error";

  if (status >= 500) {
    // Always logged, ALWAYS the real message. This is the only place the gateway
    // or database detail behind a 5xx is recorded, so a masked response body is
    // never the end of the diagnosis.
    console.error(`[errorHandler] ${req.method} ${req.originalUrl} -`, err?.message || err);

    // A 5xx body is opaque by design: stack traces, SQL and gateway internals
    // must not reach a client. But some failures carry a `publicMessage` that the
    // thrower has explicitly judged safe — e.g. "your refund did not go through
    // and nothing changed", which tells the user what to do next and leaks
    // nothing about how it broke. Absent that, the body stays generic.
    const body = { success: false, message: "Internal Server Error" };
    if (typeof err?.publicMessage === "string" && err.publicMessage.trim()) {
      body.message = err.publicMessage;
    }
    return res.status(status).json(body);
  }

  // A coded error carries a machine-readable `code` plus whatever extra context
  // the thrower attached (e.g. which module needs an upgrade). This is what lets
  // the frontend render "upgrade to unlock Payroll" instead of a generic
  // "subscription not active" banner for what is a different problem.
  const body = { success: false, message };
  if (err?.code) body.code = err.code;
  if (err?.extra && typeof err.extra === "object") Object.assign(body, err.extra);

  res.status(status).json(body);
}
