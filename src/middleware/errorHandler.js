import ApiError from "../utils/ApiError.js";

export default function errorHandler(err, req, res, next) {
  const status = err instanceof ApiError ? err.statusCode : (err.statusCode || 500);
  const message = err.message || "Server error";
  res.status(status).json({ success: false, message });
}
