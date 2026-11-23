import { AsyncLocalStorage } from "node:async_hooks";
import { and, count, eq, gte } from "drizzle-orm";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { DomainError } from "../../training/domain/rules";
import {
  cleanResourceId,
  safeContext,
  type AccessCategory,
  type AccessOperation,
} from "../domain";
/**
 * Phase 7: recording who accessed sensitive information.
 *
 * Failure policy (deliberate, uniform, tested):
 *  - A SUCCESSFUL access is TRANSACTION-CRITICAL / fail-closed. The event is written before the data is
 *    returned (inside the same transaction when the read runs in one, so a failed read leaves no event
 *    and a failed event rolls the read back). If the write fails, `recordAccess` throws, the request fails
 *    with a generic 500 and NO sensitive data leaves the server.
 *  - A DENIED access is BEST-EFFORT. The request is refused either way, so a failed denial record must
 *    not change the answer; the failure is reported in the server log (error type only, never data) and
 *    is never swallowed silently. Denials are also capped per person (see DENIAL_CAP) so repeated
 *    invalid-id requests cannot grow the table without bound.
 *
 * Recorded at the service functions that read the data, not in the browser and not (only) in a route,
 * so a direct service call is audited exactly like an HTTP call. One logical access = one event: helper
 * functions that several services share (reportAccess, mediaAccess, ...) never record anything.
 */
type Db = Pick<ReturnType<typeof database>, "insert" | "select">;
export type Who = { id: string; academyId: string; role: string };
export type AccessDescriptor = {
  category: AccessCategory;
  operation: AccessOperation;
  resourceId?: unknown;
  playerId?: unknown;
};
/** Set by the route handler for each request; absent when a service is called directly. */
export const accessScope = new AsyncLocalStorage<{
  requestId: string;
  channel: string;
}>();
/** At most this many denials per person are stored individually per window; one marker row follows. */
export const DENIAL_CAP = 30;
export const DENIAL_WINDOW_MINUTES = 10;
export async function recordAccess(
  db: Db,
  who: Who,
  e: AccessDescriptor & { context?: unknown; outcome?: "SUCCESS" | "DENIED" },
) {
  const scope = accessScope.getStore();
  const context = safeContext(e.context);
  const rawResource = e.resourceId;
  const resourceId = cleanResourceId(rawResource);
  if (rawResource != null && resourceId === null && !context.reason)
    context.reason = "BAD_ID";
  await db.insert(t.accessEvents).values({
    id: crypto.randomUUID(),
    academyId: who.academyId,
    actorId: who.id,
    actorRole: who.role,
    category: e.category,
    operation: e.operation,
    outcome: e.outcome ?? "SUCCESS",
    resourceId,
    playerId: cleanResourceId(e.playerId),
    channel: scope?.channel ?? "service",
    requestId: scope?.requestId ?? null,
    context,
    // Millisecond precision from the application clock so the history pages by (time, id) deterministically.
    createdAt: new Date(),
  });
}
/** Best-effort denial record (see the policy above). Never throws. */
export async function recordDenied(
  who: Who,
  e: AccessDescriptor,
  status: number,
  db: Db = database(),
) {
  try {
    const since = new Date(Date.now() - DENIAL_WINDOW_MINUTES * 60_000);
    const [{ n }] = await db
      .select({ n: count() })
      .from(t.accessEvents)
      .where(
        and(
          eq(t.accessEvents.academyId, who.academyId),
          eq(t.accessEvents.actorId, who.id),
          eq(t.accessEvents.outcome, "DENIED"),
          gte(t.accessEvents.createdAt, since),
        ),
      );
    if (n > DENIAL_CAP) return;
    if (n === DENIAL_CAP) {
      await recordAccess(db, who, {
        category: e.category,
        operation: "THROTTLED",
        outcome: "DENIED",
        context: { limit: DENIAL_CAP, windowMinutes: DENIAL_WINDOW_MINUTES },
      });
      return;
    }
    await recordAccess(db, who, {
      ...e,
      outcome: "DENIED",
      context: { status, reason: status === 403 ? "ROLE" : "NOT_FOUND" },
    });
  } catch (error) {
    // Reported, not hidden: an operator needs to know the denial history has a gap.
    console.error(
      "Access audit (denial) write failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}
/**
 * Runs a sensitive read; a refusal (403 not permitted, 404 not found for this person) is recorded as a
 * DENIED event after the read's own transaction has rolled back, then rethrown unchanged.
 */
export async function denialAudited<T>(
  who: Who,
  descriptor: AccessDescriptor,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof DomainError &&
      (error.status === 403 || error.status === 404)
    )
      await recordDenied(who, descriptor, error.status);
    throw error;
  }
}
