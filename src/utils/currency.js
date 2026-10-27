/**
 * The application's single currency.
 *
 * WHY THIS IS A CONSTANT AND NOT A SETTING. Payroll used to take a free-text
 * three-letter code per organization, which made the currency of a payslip a
 * value an administrator could type. That is a correctness hazard rather than a
 * feature: a typo produces a payslip nobody can reconcile, and it made
 * `organization_payroll_policies.currency` one more field that could be left
 * NULL and silently block payroll at generation time.
 *
 * This product sells and pays in Pakistani Rupees, so the currency is PKR and
 * only PKR. It is declared once here so there is exactly one place to change it
 * if that ever stops being true, rather than a literal repeated across the
 * controller, the service and the database.
 *
 * Deliberately NOT configurable via the environment. An env-var currency would
 * reintroduce exactly the drift this file removes: a deployment could disagree
 * with the data already written into payslip and salary tables.
 */
export const CURRENCY = "PKR";

/** How this currency is written next to an amount in user-facing copy. */
export const CURRENCY_SYMBOL = "PKR";