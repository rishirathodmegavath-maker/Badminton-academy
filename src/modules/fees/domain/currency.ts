import { isCurrency, remaining } from "./money";
/**
 * Rules for the one-currency-per-academy policy. Pure functions over plain rows so the service, the
 * read-only integrity check and the tests all apply the same definitions.
 *
 * Lifecycle facts these rules rely on (there are no draft invoices in this application):
 *   invoice  ISSUED -> VOID                 (VOID is the "cancelled" state; nothing is ever deleted)
 *   payment  SUBMITTED -> VERIFIED | REJECTED (both decisions are final; VERIFIED can only be refunded)
 *   fee plan active | archived
 * Every invoice carries its own currency, written once at issue; payments take the currency of
 * their invoice; refunds belong to a payment. Nothing is converted.
 */
export type InvoiceRow = {
  id: string;
  status: string;
  data: { currency: string; total: number; subtotal?: number; discount?: number };
};
export type PaymentRow = {
  id: string;
  invoiceId: string;
  status: string;
  data: { amount: number; currency: string };
};
export type RefundRow = { paymentId: string; amount: number };
export type PlanRow = {
  id: string;
  currency: string;
  amount: number;
  archived: boolean;
};
export type MoneyRecords = {
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  refunds: RefundRow[];
  plans: PlanRow[];
};
/** What is still owed on an invoice: total, less verified payments, plus recorded refunds. */
export function invoiceBalance(
  invoice: InvoiceRow,
  payments: PaymentRow[],
  refunds: RefundRow[],
) {
  const mine = payments.filter((p) => p.invoiceId === invoice.id);
  const verified = mine.filter((p) => p.status === "VERIFIED");
  const paid = verified.reduce((sum, p) => sum + p.data.amount, 0);
  const refunded = refunds
    .filter((r) => verified.some((p) => p.id === r.paymentId))
    .reduce((sum, r) => sum + r.amount, 0);
  return remaining(invoice.data.total, paid, refunded);
}
/**
 * Records that would be left in a different currency than the academy's if the academy currency
 * became `target`:
 *   - ISSUED invoices that are not settled (a balance other than zero, or a payment awaiting a
 *     decision). A settled or VOID invoice is history: it keeps its own currency and is untouched.
 *   - fee plans that can still be used (not archived).
 */
export function currencyChangeBlockers(records: MoneyRecords, target: string) {
  const openInvoices = records.invoices.filter(
    (i) =>
      i.status === "ISSUED" &&
      i.data.currency !== target &&
      (invoiceBalance(i, records.payments, records.refunds) !== 0 ||
        records.payments.some(
          (p) => p.invoiceId === i.id && p.status === "SUBMITTED",
        )),
  );
  const activePlans = records.plans.filter(
    (p) => !p.archived && p.currency !== target,
  );
  return {
    openInvoices: openInvoices.map((i) => i.id),
    activePlans: activePlans.map((p) => p.id),
    blocked: openInvoices.length + activePlans.length > 0,
  };
}
export type CurrencyIssue = {
  code:
    | "INVOICE_OFF_CURRENCY"
    | "PLAN_OFF_CURRENCY"
    | "PAYMENT_CURRENCY_MISMATCH"
    | "UNSUPPORTED_CURRENCY"
    | "AMOUNT_NOT_INTEGER"
    | "INVOICE_TOTAL_MISMATCH";
  record: "invoice" | "payment" | "fee_plan";
  id: string;
};
/**
 * Read-only consistency check of an academy's money records against its configured currency.
 * It reports; it never repairs or converts anything. Off-currency historical invoices are
 * expected to be reported, not rejected: they keep their currency.
 */
export function findCurrencyIssues(
  academyCurrency: string,
  records: MoneyRecords,
): CurrencyIssue[] {
  const issues: CurrencyIssue[] = [];
  const add = (code: CurrencyIssue["code"], record: CurrencyIssue["record"], id: string) =>
    issues.push({ code, record, id });
  const invoiceById = new Map(records.invoices.map((i) => [i.id, i]));
  for (const i of records.invoices) {
    if (!isCurrency(i.data.currency)) add("UNSUPPORTED_CURRENCY", "invoice", i.id);
    else if (i.data.currency !== academyCurrency) add("INVOICE_OFF_CURRENCY", "invoice", i.id);
    const { total, subtotal, discount } = i.data;
    if (![total, subtotal ?? 0, discount ?? 0].every(Number.isInteger))
      add("AMOUNT_NOT_INTEGER", "invoice", i.id);
    else if (subtotal !== undefined && discount !== undefined && total !== subtotal - discount)
      add("INVOICE_TOTAL_MISMATCH", "invoice", i.id);
  }
  for (const p of records.plans) {
    if (!isCurrency(p.currency)) add("UNSUPPORTED_CURRENCY", "fee_plan", p.id);
    else if (p.currency !== academyCurrency && !p.archived) add("PLAN_OFF_CURRENCY", "fee_plan", p.id);
    if (!Number.isInteger(p.amount)) add("AMOUNT_NOT_INTEGER", "fee_plan", p.id);
  }
  for (const p of records.payments) {
    const invoice = invoiceById.get(p.invoiceId);
    if (invoice && p.data.currency !== invoice.data.currency)
      add("PAYMENT_CURRENCY_MISMATCH", "payment", p.id);
    if (!Number.isInteger(p.data.amount)) add("AMOUNT_NOT_INTEGER", "payment", p.id);
  }
  return issues;
}
