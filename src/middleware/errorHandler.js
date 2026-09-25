import ApiError from "../utils/ApiError.js";

export default function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError ? err.statusCode : (err.statusCode || 500);
  if (status >= 500) {
    console.error(`[errorHandler] ${req.method} ${req.originalUrl} →`, err?.message || err);
    return res.status(status).json({ success: false, message: "Internal Server Error" });
  }
  const message = err.message || "Server error";
  res.status(status).json({ success: false, message });
}
