import rateLimit from "express-rate-limit";

export const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ success: false, message: "Too many webhook requests. Please try again later." });
  },
});