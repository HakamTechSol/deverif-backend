import rateLimit, { ipKeyGenerator } from "express-rate-limit";

function handler(message) {
  return (req, res, next) => {
    const err = new Error(message);
    err.statusCode = 429;
    next(err);
  };
}

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("Too many login attempts. Please try again after 15 minutes."),
});

export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("Too many password reset requests. Please try again after 1 hour."),
});

export const createRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id?.toString() || ipKeyGenerator(req),
  handler: handler("Too many verification requests. Please try again after 1 hour."),
});
