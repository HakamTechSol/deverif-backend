import ApiError from "./ApiError.js";

const PLAN_LABELS = {
  basic: "Basic",
  premium: "Premium"
};

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function createPlanConfig(code, defaultAmount, defaultDurationDays) {
  return {
    code,
    label: PLAN_LABELS[code],
    amount: parsePositiveNumber(process.env[`${code.toUpperCase()}_PLAN_AMOUNT`], defaultAmount),
    duration_days: Math.trunc(
      parsePositiveNumber(process.env[`${code.toUpperCase()}_PLAN_DURATION_DAYS`], defaultDurationDays)
    )
  };
}

export function getPurchasablePlans() {
  return {
    basic: createPlanConfig("basic", 2500, 30),
    premium: createPlanConfig("premium", 5000, 30)
  };
}

export function getPurchasablePlan(planCode) {
  const plan = getPurchasablePlans()[planCode];

  if (!plan) {
    throw new ApiError(400, "Only basic and premium plans can be purchased");
  }

  return plan;
}

export function calculatePlanExpiry(currentExpiry, durationDays) {
  const now = new Date();
  const activeExpiry = currentExpiry ? new Date(currentExpiry) : null;
  const baseDate = activeExpiry instanceof Date && !Number.isNaN(activeExpiry.valueOf()) && activeExpiry > now
    ? activeExpiry
    : now;

  const nextExpiry = new Date(baseDate);
  nextExpiry.setDate(nextExpiry.getDate() + durationDays);

  return nextExpiry;
}
