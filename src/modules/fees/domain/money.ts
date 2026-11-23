import { DomainError } from "../../training/domain/rules";
/**
 * The currencies an academy can bill in, with the number of minor-unit digits (every amount is
 * stored as an integer count of minor units) and the number-format locale of the currency's home
 * market. There is deliberately no conversion anywhere: an amount is only ever read in the
 * currency it was stored with.
 */
export const CURRENCIES = {
  INR: { exponent: 2, locale: "en-IN" },
  USD: { exponent: 2, locale: "en-US" },
} as const;
export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = ["INR", "USD"] as const satisfies readonly CurrencyCode[];
export const isCurrency = (code: string): code is CurrencyCode =>
  Object.hasOwn(CURRENCIES, code);
const specOf = (currency: string) =>
  isCurrency(currency) ? CURRENCIES[currency] : { exponent: 2, locale: "en-IN" };
/** Display form for screens, for example "₹1,00,000.00" or "$100,000.00". */
export function formatMoney(minor: number, currency: string) {
  const { exponent, locale } = specOf(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    minor / 10 ** exponent,
  );
}
/** Plain form for documents, for example "INR 1000.00". */
export function plainMoney(minor: number, currency: string) {
  const { exponent } = specOf(currency);
  return `${currency} ${(minor / 10 ** exponent).toFixed(exponent)}`;
}
export function minorUnits(input: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(input))
    throw new DomainError(
      "Enter a non-negative amount with up to two decimal places.",
    );
  const [whole, fraction = ""] = input.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount > 1_000_000_000)
    throw new DomainError("Amount exceeds the supported limit.");
  return amount;
}
export function invoiceTotal(subtotal: number, discount: number) {
  if (
    !Number.isSafeInteger(subtotal) ||
    !Number.isSafeInteger(discount) ||
    subtotal <= 0 ||
    discount < 0 ||
    discount > subtotal
  )
    throw new DomainError(
      "Discount must be between zero and the invoice subtotal.",
    );
  return subtotal - discount;
}
export function remaining(total: number, verified: number, refunded: number) {
  return total - verified + refunded;
}
