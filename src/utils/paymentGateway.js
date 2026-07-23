import crypto from "crypto";
import ApiError from "./ApiError.js";

const PROVIDER_LABELS = {
  jazzcash: "JazzCash",
  easypaisa: "Easypaisa"
};

const DEFAULT_EASYPAISA_HASH_FIELDS = [
  "amount",
  "autoRedirect",
  "emailAddr",
  "expiryDate",
  "mobileNum",
  "orderRefNum",
  "paymentMethod",
  "postBackURL",
  "storeId"
];

function normalizeProvider(provider) {
  return String(provider || "").trim().toLowerCase();
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, "base64").toString("utf8");
}

function createHmac(secret, value) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function getPaymentReferenceSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_me") {
    throw new ApiError(500, "JWT secret is not configured");
  }

  return process.env.JWT_SECRET;
}

function formatJazzCashDate(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];

  return parts.join("");
}

function formatEasypaisaExpiry(date) {
  const parts = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ];

  return parts.join("");
}

function getPublicBaseUrl() {
  const baseUrl = process.env.PAYMENT_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
  return baseUrl.replace(/\/$/, "");
}

function ensureEnv(names, providerLabel) {
  const missing = names.filter(name => !process.env[name]);

  if (missing.length) {
    throw new ApiError(500, `${providerLabel} is not configured. Missing: ${missing.join(", ")}`);
  }
}

function sanitizePhone(phone) {
  return String(phone || "")
    .replace(/\D/g, "")
    .slice(-11);
}

function createMerchantTransactionId(prefix) {
  const now = new Date();
  const compactDate = [
    String(now.getFullYear()).slice(-2),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0")
  ].join("");

  return `${prefix}${compactDate}${crypto.randomBytes(2).toString("hex")}`.toUpperCase();
}

function buildFrontendReturnUrl({ provider, status, transactionReference, planCode }) {
  const frontendUrl = process.env.PAYMENT_FRONTEND_RETURN_URL;

  if (!frontendUrl) return null;

  const url = new URL(frontendUrl);
  url.searchParams.set("provider", provider);
  url.searchParams.set("status", status);

  if (transactionReference) {
    url.searchParams.set("transaction_reference", transactionReference);
  }

  if (planCode) {
    url.searchParams.set("plan", planCode);
  }

  return url.toString();
}

function buildCallbackUrl(provider, paymentRef) {
  const url = new URL(`${getPublicBaseUrl()}/api/v1/payment/callback/${provider}`);
  url.searchParams.set("payment_ref", paymentRef);
  return url.toString();
}

function buildJazzCashSecureHash(fields) {
  const integritySalt = process.env.JAZZCASH_INTEGRITY_SALT;
  const keys = Object.keys(fields)
    .filter(key => key !== "pp_SecureHash" && fields[key] !== undefined && fields[key] !== null && fields[key] !== "")
    .sort();
  const serialized = keys.map(key => `${key}=${fields[key]}`).join("&");
  const source = serialized ? `${integritySalt}&${serialized}` : integritySalt;
  return createHmac(integritySalt, source);
}

function buildEasypaisaHash(fields) {
  const hashKey = process.env.EASYPAISA_HASH_KEY;
  const hashMode = (process.env.EASYPAISA_HASH_MODE || "key_and_pairs").toLowerCase();
  const hashFields = (process.env.EASYPAISA_HASH_FIELDS || DEFAULT_EASYPAISA_HASH_FIELDS.join(","))
    .split(",")
    .map(field => field.trim())
    .filter(Boolean);

  const pairString = hashFields.map(field => `${field}=${fields[field] || ""}`).join("&");
  const valueString = hashFields.map(field => fields[field] || "").join("&");

  let source = pairString;

  if (hashMode === "values") {
    source = valueString;
  } else if (hashMode === "key_and_values") {
    source = `${hashKey}&${valueString}`;
  } else if (hashMode === "key_and_pairs") {
    source = `${hashKey}&${pairString}`;
  }

  return createHmac(hashKey, source);
}

export function getProviderLabel(provider) {
  return PROVIDER_LABELS[normalizeProvider(provider)] || "Payment";
}

export function getEnabledProviders() {
  return Object.entries(PROVIDER_LABELS).map(([code, label]) => ({ code, label }));
}

export function createPaymentReference({ provider, userUuid, planCode, amount, purpose }) {
  const payload = {
    provider: normalizeProvider(provider),
    userUuid,
    planCode,
    amount: Number(Number(amount).toFixed(2)),
    purpose: purpose || `${planCode} plan subscription`,
    nonce: crypto.randomBytes(8).toString("hex"),
    issuedAt: Date.now()
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac(getPaymentReferenceSecret(), encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function parsePaymentReference(reference) {
  if (!reference || typeof reference !== "string" || !reference.includes(".")) {
    throw new ApiError(400, "Invalid payment reference");
  }

  const [encodedPayload, signature] = reference.split(".");
  const expectedSignature = createHmac(getPaymentReferenceSecret(), encodedPayload);

  if (signature !== expectedSignature) {
    throw new ApiError(400, "Payment reference signature is invalid");
  }

  try {
    return JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    throw new ApiError(400, "Payment reference payload is invalid");
  }
}

export function buildProviderCheckout({ provider, user, plan, purpose }) {
  const normalizedProvider = normalizeProvider(provider);
  const providerLabel = getProviderLabel(normalizedProvider);

  if (!PROVIDER_LABELS[normalizedProvider]) {
    throw new ApiError(400, "Supported providers are jazzcash and easypaisa");
  }

  const paymentReference = createPaymentReference({
    provider: normalizedProvider,
    userUuid: user.uuid,
    planCode: plan.code,
    amount: plan.amount,
    purpose
  });

  if (normalizedProvider === "jazzcash") {
    ensureEnv(["JAZZCASH_MERCHANT_ID", "JAZZCASH_PASSWORD", "JAZZCASH_INTEGRITY_SALT"], providerLabel);

    const transactionDate = new Date();
    const expiryDate = new Date(transactionDate.getTime() + 60 * 60 * 1000);
    const transactionReference = createMerchantTransactionId("JC");

    const fields = {
      pp_Version: process.env.JAZZCASH_VERSION || "1.1",
      pp_TxnType: process.env.JAZZCASH_TXN_TYPE || "MWALLET",
      pp_Language: process.env.JAZZCASH_LANGUAGE || "EN",
      pp_MerchantID: process.env.JAZZCASH_MERCHANT_ID,
      pp_Password: process.env.JAZZCASH_PASSWORD,
      pp_TxnRefNo: transactionReference,
      pp_Amount: String(Math.round(plan.amount * 100)),
      pp_TxnCurrency: process.env.JAZZCASH_CURRENCY || "PKR",
      pp_TxnDateTime: formatJazzCashDate(transactionDate),
      pp_BillReference: `${plan.code.toUpperCase()}-${user.uuid}`,
      pp_Description: purpose || `${plan.label} plan subscription`,
      pp_TxnExpiryDateTime: formatJazzCashDate(expiryDate),
      pp_ReturnURL: buildCallbackUrl(normalizedProvider, paymentReference),
      ppmpf_1: paymentReference,
      ppmpf_2: user.uuid,
      ppmpf_3: plan.code,
      pp_MobileNumber: sanitizePhone(user.phone)
    };

    if (process.env.JAZZCASH_SUB_MERCHANT_ID) {
      fields.pp_SubMerchantID = process.env.JAZZCASH_SUB_MERCHANT_ID;
    }

    if (process.env.JAZZCASH_BANK_ID) {
      fields.pp_BankID = process.env.JAZZCASH_BANK_ID;
    }

    if (process.env.JAZZCASH_PRODUCT_ID) {
      fields.pp_ProductID = process.env.JAZZCASH_PRODUCT_ID;
    }

    fields.pp_SecureHash = buildJazzCashSecureHash(fields);

    return {
      provider: normalizedProvider,
      provider_label: providerLabel,
      action_url:
        process.env.JAZZCASH_ACTION_URL ||
        "https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/",
      method: "POST",
      transaction_reference: transactionReference,
      amount: plan.amount,
      fields
    };
  }

  ensureEnv(["EASYPAISA_STORE_ID", "EASYPAISA_HASH_KEY"], providerLabel);

  const transactionReference = createMerchantTransactionId("EP");
  const expiryDate = new Date(Date.now() + 60 * 60 * 1000);
  const fields = {
    storeId: process.env.EASYPAISA_STORE_ID,
    amount: Number(plan.amount).toFixed(2),
    postBackURL: buildCallbackUrl(normalizedProvider, paymentReference),
    orderRefNum: transactionReference,
    expiryDate: formatEasypaisaExpiry(expiryDate),
    autoRedirect: process.env.EASYPAISA_AUTO_REDIRECT || "1",
    emailAddr: user.email,
    mobileNum: sanitizePhone(user.phone),
    paymentMethod: process.env.EASYPAISA_PAYMENT_METHOD || "MA_PAYMENT_METHOD"
  };

  fields.merchantHashedReq = buildEasypaisaHash(fields);

  return {
    provider: normalizedProvider,
    provider_label: providerLabel,
    action_url: process.env.EASYPAISA_ACTION_URL || "https://easypaystg.easypaisa.com.pk/easypay/Index.jsf",
    method: "POST",
    transaction_reference: transactionReference,
    amount: plan.amount,
    fields
  };
}

export function parseProviderCallback(provider, payload = {}) {
  const normalizedProvider = normalizeProvider(provider);

  if (!PROVIDER_LABELS[normalizedProvider]) {
    throw new ApiError(400, "Unsupported payment provider");
  }

  if (normalizedProvider === "jazzcash") {
    ensureEnv(["JAZZCASH_INTEGRITY_SALT"], "JazzCash");

    if (payload.pp_SecureHash) {
      const expectedHash = buildJazzCashSecureHash(payload);

      if (expectedHash !== payload.pp_SecureHash) {
        throw new ApiError(400, "JazzCash callback signature is invalid");
      }
    }

    const paymentReference = payload.ppmpf_1 || payload.payment_ref;
    const responseCode = String(payload.pp_ResponseCode || "");

    return {
      provider: normalizedProvider,
      paymentReference,
      transactionReference: payload.pp_TxnRefNo || null,
      amount: payload.pp_Amount ? Number(payload.pp_Amount) / 100 : null,
      success: responseCode === "000",
      responseCode,
      message: payload.pp_ResponseMessage || "JazzCash callback received"
    };
  }

  const paymentReference = payload.payment_ref || payload.merchantPaymentRef || payload.reference;
  const statusValue = String(
    payload.transactionStatus || payload.paymentStatus || payload.status || payload.responseCode || ""
  ).toLowerCase();
  const responseCode = String(payload.responseCode || payload.status || "");
  const success = ["paid", "success", "successful", "completed", "0000", "000"].includes(statusValue) ||
    ["0000", "000"].includes(responseCode);

  return {
    provider: normalizedProvider,
    paymentReference,
    transactionReference:
      payload.orderRefNum || payload.transactionId || payload.transactionReference || payload.txnRefNo || null,
    amount: payload.amount ? Number(payload.amount) : null,
    success,
    responseCode,
    message: payload.responseDesc || payload.message || "Easypaisa callback received"
  };
}

export function getFrontendReturnUrl(params) {
  return buildFrontendReturnUrl(params);
}


