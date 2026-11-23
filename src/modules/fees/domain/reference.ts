/**
 * Payment-reference rules (Stage 5C).
 *
 * referenceKey() is the canonical form used to decide whether two references are "the same". It
 * mirrors the database's generated column payment_reference.reference_key exactly (see
 * PAYMENT_REFERENCE_KEY_SQL in the schema); a test runs both on the same corpus.
 *   1. Unicode NFKC,
 *   2. each run of space, tab, line feed, carriage return, form feed or vertical tab -> one space,
 *      then spaces at either end removed,
 *   3. ASCII A-Z -> a-z (other letters unchanged, so the result never depends on a locale).
 * The reference exactly as submitted is stored separately and shown in history and on receipts.
 */
export function referenceKey(reference: string) {
  return reference
    .normalize("NFKC")
    .replace(/[ \t\n\r\f\v]+/g, " ")
    .replace(/^ +| +$/g, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}
/** At most this many attempts of one invoice may wait for a decision at the same time. */
export const MAX_PENDING_ATTEMPTS = 3;
export type RejectionKind = "CORRECTABLE" | "INVALID";
export const REJECTION_KINDS = ["CORRECTABLE", "INVALID"] as const;
type Attempt = {
  id: string;
  invoiceId: string;
  status: string;
  rejectionKind: string | null;
  data: { attemptNo?: number };
};
export type ReferenceDecision<T extends Attempt = Attempt> =
  | { ok: true; previous: T | null }
  | {
      ok: false;
      code:
        | "PAYMENT_REFERENCE_DUPLICATE"
        | "PAYMENT_REFERENCE_BLOCKED"
        | "PAYMENT_RESUBMISSION_INVALID";
    };
/**
 * May a reference with this key be submitted for `invoiceId`, given every earlier attempt in the
 * academy with the same key?
 *   - a live attempt (awaiting a decision, or verified) anywhere in the academy -> duplicate
 *   - an attempt rejected as INVALID, or rejected before rejection kinds existed -> blocked
 *   - an attempt rejected as CORRECTABLE for a different invoice -> invalid resubmission
 *   - otherwise allowed; the newest correctable rejection on this invoice is the attempt it replaces
 */
export function referenceDecision<T extends Attempt>(
  sameKey: T[],
  invoiceId: string,
): ReferenceDecision<T> {
  if (sameKey.some((p) => p.status === "SUBMITTED" || p.status === "VERIFIED"))
    return { ok: false, code: "PAYMENT_REFERENCE_DUPLICATE" };
  if (sameKey.some((p) => p.status === "REJECTED" && p.rejectionKind !== "CORRECTABLE"))
    return { ok: false, code: "PAYMENT_REFERENCE_BLOCKED" };
  if (sameKey.some((p) => p.invoiceId !== invoiceId))
    return { ok: false, code: "PAYMENT_RESUBMISSION_INVALID" };
  const attemptNo = (p: T) => p.data.attemptNo ?? 1;
  const previous = sameKey.reduce<T | null>(
    (latest, p) => (!latest || attemptNo(p) > attemptNo(latest) ? p : latest),
    null,
  );
  return { ok: true, previous };
}
