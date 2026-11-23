import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import * as z from "zod";
import { shownName } from "./membership";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { DomainError } from "../training/domain/rules";
import { can, rolesWith } from "./authority";
import {
  SECURITY_EVENT_META,
  SECURITY_EVENT_NAMES,
  SECURITY_OUTCOMES,
  type SecurityOutcome,
} from "./security-event-meta";
import { ACCOUNT_LEVEL_EVENTS, type SecurityEventName } from "./security-events";
import { denialAudited, recordAccess } from "../audit/application/record";
/**
 * Read-only view of `security_event` for the people who administer an academy's accounts.
 *
 * Boundaries (each is covered by tests/security-event-log.test.ts):
 *  - Only OWNER and ADMIN may read it. Everyone else gets the generic 403 used elsewhere.
 *  - Academy isolation: an event belongs to the academy stamped on it when it was written
 *    (`recordSecurityEvent`). Older rows with no academy are shown only when the person they are
 *    about belongs to this academy and to no other, so nothing can surface in two academies.
 *  - Output is an allow-list. Rows are never returned as stored: `detail` is copied key by key
 *    through DETAIL_KEYS with type checks, so a future caller that stores something extra in
 *    `detail` cannot leak it here. Passwords, hashes, tokens, TOTP secrets and recovery codes are
 *    never written to the table in the first place; this is the second line of defence.
 *  - People are named only if they are members of this academy.
 *  - There is no write path: this module only selects, and no route calls anything that updates or
 *    deletes from `security_event`.
 *
 * Deliberately NOT here (later phases): logging who read profiles, reports, PDFs or media.
 */
/** Derived from the authority module (RC-1); kept under its old name. */
export const SECURITY_EVENT_VIEWERS = rolesWith("logs.security");
export const SECURITY_EVENT_PAGE_DEFAULT = 25;
export const SECURITY_EVENT_PAGE_MAX = 100;
type Viewer = { id: string; academyId: string; role: string };
const instant = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Not a valid date.");
const query = z.object({
  event: z.enum(SECURITY_EVENT_NAMES as [SecurityEventName, ...SecurityEventName[]]).optional(),
  outcome: z.enum(SECURITY_OUTCOMES as [SecurityOutcome, ...SecurityOutcome[]]).optional(),
  person: z.string().trim().min(1).max(200).optional(),
  from: instant.optional(),
  to: instant.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SECURITY_EVENT_PAGE_MAX)
    .default(SECURITY_EVENT_PAGE_DEFAULT),
  cursor: z.string().max(300).optional(),
});
export type SecurityEventQuery = z.input<typeof query>;
const roleList = (v: unknown) =>
  Array.isArray(v) && v.length <= 20 && v.every((r) => typeof r === "string")
    ? (v as string[]).map((r) => r.slice(0, 40))
    : undefined;
/** `detail` keys that may be shown, and the shape each must have. Everything else is dropped. */
const DETAIL_KEYS: Record<string, (v: unknown) => unknown> = {
  reason: (v) => (typeof v === "string" ? v.slice(0, 500) : undefined),
  expiresAt: (v) =>
    typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : undefined,
  revokedSessions: (v) => (Number.isInteger(v) ? v : undefined),
  // Multi-academy (0017): whether a deactivation also ended the person's sessions, and whether choosing an academy
  // was a switch. Flags only.
  endedAllSessions: (v) => (typeof v === "boolean" ? v : undefined),
  // Invitations (0018): the kind of invitation. Never an address, a token or a player's name.
  kind: (v) => (typeof v === "string" ? v.slice(0, 20) : undefined),
  switched: (v) => (typeof v === "boolean" ? v : undefined),
  authenticatorRemoved: (v) => (typeof v === "boolean" ? v : undefined),
  wasTemporary: (v) => (typeof v === "boolean" ? v : undefined),
  generated: (v) => (typeof v === "boolean" ? v : undefined),
  failures: (v) => (Number.isInteger(v) ? v : undefined),
  operator: (v) => (typeof v === "string" ? v.slice(0, 80) : undefined),
  fromRole: (v) => (typeof v === "string" ? v.slice(0, 40) : undefined),
  toRole: (v) => (typeof v === "string" ? v.slice(0, 40) : undefined),
  fromMode: (v) => (typeof v === "string" ? v.slice(0, 20) : undefined),
  toMode: (v) => (typeof v === "string" ? v.slice(0, 20) : undefined),
  roles: roleList,
  fromRoles: roleList,
  // Withdrawn reports and nutrition plans (Phase 6): a kind, a record reference and a role only.
  contentType: (v) => (typeof v === "string" ? v.slice(0, 30) : undefined),
  actorRole: (v) => (typeof v === "string" ? v.slice(0, 30) : undefined),
  // Retention, erasure and legal holds (Phase 8): a kind, a reference and a number. Never a name or a reason.
  action: (v) => (typeof v === "string" ? v.slice(0, 20) : undefined),
  scope: (v) => (typeof v === "string" ? v.slice(0, 20) : undefined),
  days: (v) => (Number.isInteger(v) ? v : undefined),
  emergency: (v) => (typeof v === "boolean" ? v : undefined),
  requiredDays: (v) => (Number.isInteger(v) ? v : undefined),
  daysElapsed: (v) => (Number.isInteger(v) ? v : undefined),
  // Consent events (Phase 5): identifiers and kinds only - never a child's name or document text.
  category: (v) => (typeof v === "string" ? v.slice(0, 30) : undefined),
  method: (v) => (typeof v === "string" ? v.slice(0, 30) : undefined),
  version: (v) => (Number.isInteger(v) ? v : undefined),
  ref: (v) => (typeof v === "string" ? v.slice(0, 80) : undefined),
  lapsed: (v) => (Number.isInteger(v) ? v : undefined),
  requireRenewal: (v) => (typeof v === "boolean" ? v : undefined),
};
export function safeDetail(detail: unknown) {
  const out: Record<string, unknown> = {};
  if (!detail || typeof detail !== "object" || Array.isArray(detail))
    return out;
  for (const [key, check] of Object.entries(DETAIL_KEYS)) {
    const shown = check((detail as Record<string, unknown>)[key]);
    if (shown !== undefined) out[key] = shown;
  }
  return out;
}
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
/** A user who belongs to this academy and to no other (so an academy-less row about them is theirs to show). */
const onlyHere = (column: unknown, academyId: string) =>
  sql`(exists (select 1 from ${t.memberships} m where m.user_id = ${column} and m.academy_id = ${academyId}) and not exists (select 1 from ${t.memberships} o where o.user_id = ${column} and o.academy_id <> ${academyId}))`;
/** A user who is an ACTIVE member of this academy (whatever other academies they also belong to). */
const activeHere = (column: unknown, academyId: string) =>
  sql`exists (select 1 from ${t.memberships} m where m.user_id = ${column} and m.academy_id = ${academyId} and m.active = true)`;
/** Phase 7: reading the security log is itself recorded (ACCOUNT_SECURITY), fail-closed; refusals as DENIED. */
export async function listSecurityEvents(viewer: Viewer, input: unknown) {
  return denialAudited(
    viewer,
    { category: "ACCOUNT_SECURITY", operation: "LIST" },
    async () => {
      const result = await listSecurityEventsRead(viewer, input);
      await recordAccess(database(), viewer, {
        category: "ACCOUNT_SECURITY",
        operation: "LIST",
        context: { count: result.events.length },
      });
      return result;
    },
  );
}
async function listSecurityEventsRead(viewer: Viewer, input: unknown) {
  if (!can(viewer, "logs.security"))
    throw new DomainError("Your role cannot perform this action.", 403);
  const q = query.parse(input ?? {});
  const db = database();
  const conditions = [
    or(
      eq(t.securityEvent.academyId, viewer.academyId),
      and(
        isNull(t.securityEvent.academyId),
        or(
          onlyHere(t.securityEvent.targetUserId, viewer.academyId),
          onlyHere(t.securityEvent.actorId, viewer.academyId),
          // A person's own sign-in and credential events (no academy of their own) are shown to every academy they
          // are an active member of, so belonging to several academies does not hide them from all of them.
          and(
            inArray(t.securityEvent.event, [...ACCOUNT_LEVEL_EVENTS]),
            or(
              activeHere(t.securityEvent.targetUserId, viewer.academyId),
              activeHere(t.securityEvent.actorId, viewer.academyId),
            ),
          ),
        ),
      ),
    ),
  ];
  if (q.event) conditions.push(eq(t.securityEvent.event, q.event));
  if (q.outcome)
    conditions.push(
      inArray(
        t.securityEvent.event,
        SECURITY_EVENT_NAMES.filter(
          (e) => SECURITY_EVENT_META[e].outcome === q.outcome,
        ),
      ),
    );
  if (q.person)
    conditions.push(
      or(
        eq(t.securityEvent.actorId, q.person),
        eq(t.securityEvent.targetUserId, q.person),
      )!,
    );
  if (q.from) conditions.push(gte(t.securityEvent.createdAt, new Date(q.from)));
  if (q.to) conditions.push(lte(t.securityEvent.createdAt, new Date(q.to)));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    conditions.push(
      or(
        lt(t.securityEvent.createdAt, c.at),
        and(eq(t.securityEvent.createdAt, c.at), lt(t.securityEvent.id, c.id)),
      )!,
    );
  }
  const rows = await db
    .select({
      id: t.securityEvent.id,
      event: t.securityEvent.event,
      createdAt: t.securityEvent.createdAt,
      actorId: t.securityEvent.actorId,
      targetUserId: t.securityEvent.targetUserId,
      detail: t.securityEvent.detail,
    })
    .from(t.securityEvent)
    .where(and(...conditions))
    .orderBy(desc(t.securityEvent.createdAt), desc(t.securityEvent.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  // Names only for people who are members of THIS academy.
  const ids = [
    ...new Set(
      page.flatMap((r) => [r.actorId, r.targetUserId]).filter(Boolean),
    ),
  ] as string[];
  const people = new Map<
    string,
    { id: string; name: string; role: string; active: boolean }
  >();
  if (ids.length)
    for (const p of await db
      .select({
        id: t.user.id,
        name: shownName,
        role: t.memberships.role,
        active: t.memberships.active,
      })
      .from(t.memberships)
      .innerJoin(t.user, eq(t.user.id, t.memberships.userId))
      .where(
        and(
          eq(t.memberships.academyId, viewer.academyId),
          inArray(t.memberships.userId, ids),
        ),
      ))
      people.set(p.id, p);
  const known = (id: string | null) => (id ? (people.get(id) ?? null) : null);
  const last = page[page.length - 1];
  return {
    events: page.map((r) => {
      const meta = SECURITY_EVENT_META[r.event as SecurityEventName];
      return {
        id: r.id,
        event: r.event,
        // Unknown names (written by a newer build) are shown as stored text, never as markup.
        label: meta?.label ?? r.event,
        outcome: meta?.outcome ?? null,
        at: r.createdAt.toISOString(),
        actor: known(r.actorId),
        target: known(r.targetUserId),
        detail: safeDetail(r.detail),
      };
    }),
    nextCursor:
      rows.length > q.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
