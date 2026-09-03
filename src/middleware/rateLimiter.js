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

export const contactLeadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("Too many submissions. Please try again after 1 hour."),
});

export const accessRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("Too many requests. Please try again after 1 hour."),
});

export const createRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id?.toString() || ipKeyGenerator(req),
  handler: handler("Too many verification requests. Please try again after 1 hour."),
});

export const publicVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: handler("Too many verification lookups. Please try again later."),
});

// OTP verification + resend (prevents code brute-force and email bombing)
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.body?.identity_type || "x"}:${req.body?.identity_id || ipKeyGenerator(req)}`,
  handler: handler("Too many verification attempts. Please try again after 15 minutes."),
});

// Leave request submission
export const createLeaveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id?.toString() || ipKeyGenerator(req),
  handler: handler("Too many leave requests submitted. Please try again after 1 hour."),
});

// Attendance check-in / check-out (prevents spam marking)
export const attendanceLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id?.toString() || ipKeyGenerator(req),
  handler: handler("Too many attendance attempts. Please try again later."),
});

// Employee creation (org-admin / platform admin)
export const createEmployeeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.admin?.id?.toString() || req.user?.id?.toString() || ipKeyGenerator(req),
  handler: handler("Too many employees created. Please try again after 1 hour."),
});
