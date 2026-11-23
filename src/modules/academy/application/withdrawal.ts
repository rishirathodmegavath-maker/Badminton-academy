import { and, eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { recordSecurityEvent } from "../../identity/security-events";
import { DomainError } from "../../training/domain/rules";
import type { Tx } from "./access";
import {
  PUBLISHED_STATUS,
  publicationState,
  validWithdrawalReason,
  type PublishedKind,
  type Withdrawal,
} from "../domain/withdrawal";
/**
 * Phase 6: withdrawing published content from families. This is deliberately NOT revising:
 *  - revise: the working copy goes back to DRAFT, the last published revision stays available;
 *  - withdraw: the published revision stops being available to families, the history is kept.
 * A withdrawal never edits or deletes an earlier revision. It appends a marker revision (see
 * domain/withdrawal.ts), bumps the record version (so a concurrent edit gets the usual 409), writes
 * the audit row and a security event, all in the caller's transaction (which holds the academy lock).
 */
export function withdrawalReason(raw: string) {
  if (!validWithdrawalReason(raw))
    throw new DomainError(
      "Say why this is being withdrawn (at least 10 characters, in words). The reason is kept in the record's history.",
      422,
      "WITHDRAWAL_REASON_REQUIRED",
    );
  return raw.trim();
}
const EVENT = {
  report: "REPORT_WITHDRAWN",
  "nutrition-plan": "NUTRITION_PLAN_WITHDRAWN",
} as const;
export async function withdrawPublished(
  tx: Tx,
  a: Actor,
  o: {
    kind: PublishedKind;
    row: { id: string; version: number; status: string; data: unknown };
    reason: string;
    /** Persists the record's new status and version; returns the saved row. */
    save: (status: string, version: number) => Promise<unknown>;
  },
) {
  const revisions = await tx
    .select()
    .from(t.recordRevisions)
    .where(
      and(
        eq(t.recordRevisions.academyId, a.academyId),
        eq(t.recordRevisions.entityId, o.row.id),
        eq(t.recordRevisions.kind, o.kind),
      ),
    );
  const published = PUBLISHED_STATUS[o.kind];
  const atRow = o.row.status === published;
  const state = publicationState(revisions, o.kind);
  // The published revision being withdrawn: the record itself when it is published right now,
  // otherwise the revision families can still see while a newer one is being worked on.
  const withdrawnVersion = atRow ? o.row.version : state.live?.version;
  if (withdrawnVersion === undefined)
    throw new DomainError(
      state.withdrawn || o.row.status === "WITHDRAWN"
        ? "This has already been withdrawn."
        : "Nothing is published to withdraw.",
      409,
      state.withdrawn || o.row.status === "WITHDRAWN"
        ? "ALREADY_WITHDRAWN"
        : "NOT_PUBLISHED",
    );
  const status = atRow ? "WITHDRAWN" : o.row.status;
  const version = o.row.version + 1;
  const withdrawal: Withdrawal = {
    contentType: o.kind,
    withdrawnVersion,
    actorId: a.id,
    actorRole: a.role,
    at: new Date().toISOString(),
    reason: o.reason,
  };
  const saved = await o.save(status, version);
  const revisionId = crypto.randomUUID();
  await tx.insert(t.recordRevisions).values({
    id: revisionId,
    academyId: a.academyId,
    entityId: o.row.id,
    kind: o.kind,
    version,
    data: { data: o.row.data, status, reason: o.reason, withdrawal },
  });
  await tx.insert(t.audit).values({
    id: crypto.randomUUID(),
    academyId: a.academyId,
    actorId: a.id,
    entityId: o.row.id,
    action: `${o.kind}-withdrawn`,
    version,
    detail: { withdrawnVersion, revisionId },
  });
  // Identifiers only: no player name, no content, no reason (the reason lives in the record history).
  await recordSecurityEvent(tx, {
    event: EVENT[o.kind],
    academyId: a.academyId,
    actorId: a.id,
    detail: {
      contentType: o.kind,
      ref: o.row.id,
      version: withdrawnVersion,
      actorRole: a.role,
    },
  });
  return saved;
}
