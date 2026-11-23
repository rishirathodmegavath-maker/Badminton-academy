/**
 * Phase 6: when is published content still available to families?
 *
 * Pure rules (no server imports) so the server and the staff screens agree. Nothing here changes
 * how revising works: a revision puts the working copy back to DRAFT while the last published
 * revision stays in force. Only an explicit withdrawal ends that, by writing a *withdrawal marker*
 * into the same append-only revision history (a revision whose data carries `withdrawal`). The
 * rule is: families see the newest published revision that is newer than the newest marker.
 */
export type PublishedKind = "report" | "nutrition-plan";
/** The status a revision carries when families may see it. */
export const PUBLISHED_STATUS: Record<PublishedKind, string> = {
  report: "PUBLISHED",
  "nutrition-plan": "SHARED",
};
type Revision = { kind: string; version: number; data: unknown };
export type Withdrawal = {
  contentType: PublishedKind;
  /** The published revision that was taken away from families. */
  withdrawnVersion: number;
  actorId: string;
  actorRole: string;
  at: string;
  reason: string;
};
export const withdrawalOf = (r: { data: unknown }): Withdrawal | null =>
  ((r.data as { withdrawal?: Withdrawal } | null)?.withdrawal ?? null) as
    | Withdrawal
    | null;
const statusOf = (r: { data: unknown }) =>
  (r.data as { status?: string } | null)?.status;
/**
 * Where does this record's history stand? `live` is the revision families may see (null when none),
 * `withdrawn` says the newest decision was a withdrawal. Pass the revisions of ONE record.
 */
export function publicationState<T extends Revision>(
  revisions: T[],
  kind: PublishedKind,
): { live: T | null; withdrawn: boolean } {
  const newestFirst = revisions
    .filter((r) => r.kind === kind)
    .sort((a, b) => b.version - a.version);
  for (const r of newestFirst) {
    if (withdrawalOf(r)) return { live: null, withdrawn: true };
    if (statusOf(r) === PUBLISHED_STATUS[kind]) return { live: r, withdrawn: false };
  }
  return { live: null, withdrawn: false };
}
/** A withdrawal reason has to say something: not blank filler. Length is also bounded. */
export function validWithdrawalReason(text: string) {
  const reason = text.trim();
  const words = reason.toLowerCase().match(/\p{L}{2,}/gu) ?? [];
  return (
    reason.length >= 10 &&
    reason.length <= 500 &&
    words.length >= 3 &&
    new Set(words).size >= 2
  );
}
