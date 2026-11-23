import { and, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm";
import * as z from "zod";
import { shownName } from "../../identity/membership";
import { database } from "../../../infrastructure/database/client";
import * as t from "../../../infrastructure/database/schema";
import { DomainError } from "../../training/domain/rules";
import { can } from "../../identity/authority";
import {
  ACCESS_CATEGORIES,
  ACCESS_LABEL,
  ACCESS_OPERATIONS,
  ACCESS_OUTCOMES,
  OPERATION_LABEL,
  safeContext,
  type AccessCategory,
  type AccessOperation,
  type AccessOutcome,
} from "../domain";
import { denialAudited, recordAccess, type Who } from "./record";
/**
 * Read-only investigation view of `access_event` for OWNER and ADMIN of the academy.
 *
 * Boundaries (each covered by tests/access-audit.test.ts):
 *  - Only OWNER and ADMIN. Anyone else gets the generic 403 (and that refusal is itself recorded).
 *  - Academy isolation is in the query itself: every condition is ANDed with the viewer's academy, taken
 *    from the session, never from the request. A filter can narrow results, never widen them.
 *  - Output is an allow-list: columns are copied one by one, `context` goes through safeContext again,
 *    unknown categories/operations are shown as stored text. No record contents exist to leak: the table
 *    holds identifiers, kinds, counts and outcomes only.
 *  - People and players are named only if they belong to this academy.
 *  - Keyset pagination on (created_at, id), bounded page size, `limit + 1` rows read, never the whole table.
 *  - Reading the history is itself recorded (category AUDIT_LOG) so the auditors are auditable.
 *  - No write path: nothing here, and no route, updates or deletes from `access_event`.
 */
export const ACCESS_LOG_PAGE_DEFAULT = 25;
export const ACCESS_LOG_PAGE_MAX = 100;
const instant = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Not a valid date.");
const query = z.object({
  category: z.enum(ACCESS_CATEGORIES).optional(),
  operation: z.enum(ACCESS_OPERATIONS).optional(),
  outcome: z.enum(ACCESS_OUTCOMES).optional(),
  actor: z.string().trim().min(1).max(200).optional(),
  // A record id: matches the resource or the player the access concerned.
  resource: z.string().trim().min(1).max(64).optional(),
  from: instant.optional(),
  to: instant.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ACCESS_LOG_PAGE_MAX)
    .default(ACCESS_LOG_PAGE_DEFAULT),
  cursor: z.string().max(300).optional(),
});
const encodeCursor = (at: Date, id: string) =>
  Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
function decodeCursor(value: string) {
  const [iso, id, ...rest] = Buffer.from(value, "base64url")
    .toString("utf8")
    .split("|");
  const at = new Date(iso ?? "");
  if (rest.length || !id || Number.isNaN(at.getTime()))
    throw new DomainError("That page reference is not valid.", 400);
  return { at, id };
}
export async function listAccessEvents(viewer: Who, input: unknown) {
  return denialAudited(
    viewer,
    { category: "AUDIT_LOG", operation: "LIST" },
    async () => {
      if (!can(viewer, "logs.access"))
        throw new DomainError("Your role cannot perform this action.", 403);
      const q = query.parse(input ?? {});
      const db = database();
      const conditions = [eq(t.accessEvents.academyId, viewer.academyId)];
      if (q.category) conditions.push(eq(t.accessEvents.category, q.category));
      if (q.operation) conditions.push(eq(t.accessEvents.operation, q.operation));
      if (q.outcome) conditions.push(eq(t.accessEvents.outcome, q.outcome));
      if (q.actor) conditions.push(eq(t.accessEvents.actorId, q.actor));
      if (q.resource)
        conditions.push(
          or(
            eq(t.accessEvents.resourceId, q.resource),
            eq(t.accessEvents.playerId, q.resource),
          )!,
        );
      if (q.from) conditions.push(gte(t.accessEvents.createdAt, new Date(q.from)));
      if (q.to) conditions.push(lte(t.accessEvents.createdAt, new Date(q.to)));
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        conditions.push(
          or(
            lt(t.accessEvents.createdAt, c.at),
            and(eq(t.accessEvents.createdAt, c.at), lt(t.accessEvents.id, c.id)),
          )!,
        );
      }
      const rows = await db
        .select()
        .from(t.accessEvents)
        .where(and(...conditions))
        .orderBy(desc(t.accessEvents.createdAt), desc(t.accessEvents.id))
        .limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const peopleIds = [...new Set(page.map((r) => r.actorId))];
      const playerIds = [
        ...new Set(page.map((r) => r.playerId).filter(Boolean)),
      ] as string[];
      const people = new Map<string, { id: string; name: string; active: boolean }>();
      if (peopleIds.length)
        for (const p of await db
          .select({
            id: t.user.id,
            name: shownName,
            active: t.memberships.active,
          })
          .from(t.memberships)
          .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
          .where(
            and(
              eq(t.memberships.academyId, viewer.academyId),
              inArray(t.memberships.userId, peopleIds),
            ),
          ))
          people.set(p.id, p);
      const players = new Map<string, string>();
      if (playerIds.length)
        for (const p of await db
          .select({ id: t.players.id, name: t.players.name })
          .from(t.players)
          .where(
            and(
              eq(t.players.academyId, viewer.academyId),
              inArray(t.players.id, playerIds),
            ),
          ))
          players.set(p.id, p.name);
      const last = page[page.length - 1];
      const result = {
        events: page.map((r) => ({
          id: r.id,
          at: r.createdAt.toISOString(),
          category: r.category,
          categoryLabel: ACCESS_LABEL[r.category as AccessCategory] ?? r.category,
          operation: r.operation,
          operationLabel:
            OPERATION_LABEL[r.operation as AccessOperation] ?? r.operation,
          outcome: r.outcome as AccessOutcome,
          actor: {
            id: r.actorId,
            role: r.actorRole,
            name: people.get(r.actorId)?.name ?? null,
            active: people.get(r.actorId)?.active ?? false,
          },
          resourceId: r.resourceId,
          player: r.playerId
            ? { id: r.playerId, name: players.get(r.playerId) ?? null }
            : null,
          channel: r.channel,
          requestId: r.requestId,
          context: safeContext(r.context),
        })),
        nextCursor:
          rows.length > q.limit && last
            ? encodeCursor(last.createdAt, last.id)
            : null,
      };
      // Fail-closed like every other sensitive read: no event, no data.
      await recordAccess(db, viewer, {
        category: "AUDIT_LOG",
        operation: "LIST",
        context: { count: page.length },
      });
      return result;
    },
  );
}
