import { Router } from "express";
import { webhookRateLimiter } from "../middleware/webhookRateLimit.js";
import { handlePaymentWebhook } from "../controllers/paymentWebhook.controller.js";

const router = Router();

// Public endpoint. Signature verification happens inside the handler;
// the rate limiter protects against abuse/retry storms.
router.post("/", webhookRateLimiter, handlePaymentWebhook);

export default router;