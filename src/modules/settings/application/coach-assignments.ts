import { and, asc, eq, inArray } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { DomainError } from "../../training/domain/rules";
import { coachingRoles, history, type Tx } from "../../academy/application/access";
import { overlaps } from "../../calendar/application/scheduling";

/**
 * Stage 5D: coach deactivation and batch assignment integrity.
 *
 * Invariant: every batch is coached by an ACTIVE member of the same academy whose role can coach
 * (OWNER, ADMIN, HEAD_COACH, COACH). The database enforces it for batches (migration 0011:
 * `batch_coach_must_coach` and `membership_coach_assignments`); this module keeps the application in
 * step with it and hands a departing coach's open work to a replacement in the same transaction:
 *
 *  - batches                         -> reassigned to the replacement;
 *  - DRAFT and PUBLISHED sessions    -> reassigned (they have not taken place);
 *  - SCHEDULED events starting later -> reassigned;
 *  - IN_PROGRESS sessions            -> the change is refused until the session is completed or cancelled;
 *  - COMPLETED and CANCELLED sessions, and events that already started -> untouched (history keeps
 *    the coach who actually held them).
 *
 * Concurrency: every caller runs inside `unit()` (academy row locked FOR UPDATE), and the rows read
 * here are locked FOR UPDATE as well; session and event writes also compare versions.
 */
export const COACH_ASSIGNMENT_CODES = [
  "COACH_REPLACEMENT_REQUIRED",
  "COACH_REPLACEMENT_INVALID",
  "COACH_REPLACEMENT_CONFLICT",
  "COACH_SESSION_IN_PROGRESS",
  "COACH_ASSIGNMENT_INVALID",
] as const;
export type CoachAssignmentCode = (typeof COACH_ASSIGNMENT_CODES)[number];

export const canCoach = (m: { active: boolean; role: string } | undefined) =>
  !!m && m.active && coachingRoles.includes(m.role);

/** Session statuses that still belong to whoever coaches them next. */
const OPEN_SESSION = ["DRAFT", "PUBLISHED", "IN_PROGRESS"];

/** The membership row, locked so its role and active flag cannot change under the caller. */
export async function lockedMembership(tx: Tx, academyId: string, userId: string) {
  const [row] = await tx
    .select()
    .from(t.memberships)
    .where(and(eq(t.memberships.academyId, academyId), eq(t.memberships.userId, userId)))
    .for("update");
  return row;
}

/** Refuses new work (a copied session) for someone who can no longer coach in this academy. */
export async function requireActiveCoach(tx: Tx, academyId: string, coachId: string) {
  if (!canCoach(await lockedMembership(tx, academyId, coachId)))
    throw new DomainError(
      "This session's coach no longer has active coaching access. Create a new session for an active coach instead of copying this one.",
      409,
      "COACH_ASSIGNMENT_INVALID",
    );
}

/** What a coach still has open in an academy, locked for the rest of the transaction. */
export async function openCoachingWork(tx: Tx, academyId: string, coachId: string, now = new Date()) {
  const batches = await tx
    .select()
    .from(t.batches)
    .where(and(eq(t.batches.academyId, academyId), eq(t.batches.coachId, coachId)))
    .orderBy(asc(t.batches.id))
    .for("update");
  const sessions = await tx
    .select()
    .from(t.trainingSessions)
    .where(
      and(
        eq(t.trainingSessions.academyId, academyId),
        eq(t.trainingSessions.coachId, coachId),
        inArray(t.trainingSessions.status, OPEN_SESSION),
      ),
    )
    .orderBy(asc(t.trainingSessions.id))
    .for("update");
  const scheduled = await tx
    .select()
    .from(t.calendarEvents)
    .where(and(eq(t.calendarEvents.academyId, academyId), eq(t.calendarEvents.status, "SCHEDULED")))
    .orderBy(asc(t.calendarEvents.id))
    .for("update");
  const events = scheduled.filter(
    (e) => e.kind !== "CLOSURE" && e.data.coachId === coachId && Date.parse(e.data.startsAt) > now.getTime(),
  );
  return { batches, sessions, events };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Hands a coach's open work to `replacementId` before their membership stops being able to coach.
 * Call it inside the same transaction as the membership change, BEFORE that change is written.
 * Returns what moved; throws (rolling everything back) when the hand-over is not possible.
 */
export async function handOverCoaching(
  tx: Tx,
  a: Actor,
  input: { coachId: string; replacementId: string | null; reason: "DEACTIVATION" | "ROLE_CHANGE" },
) {
  const now = new Date();
  const work = await openCoachingWork(tx, a.academyId, input.coachId, now);
  const live = work.sessions.filter((s) => s.status === "IN_PROGRESS");
  if (live.length)
    throw new DomainError(
      `This coach has ${plural(live.length, "session")} in progress. Complete or cancel it before changing their access.`,
      409,
      "COACH_SESSION_IN_PROGRESS",
    );
  const summary = {
    replacementCoachId: null as string | null,
    batches: work.batches.map((b) => b.id),
    sessions: work.sessions.map((s) => s.id),
    events: work.events.map((e) => e.id),
  };
  if (!work.batches.length && !work.sessions.length && !work.events.length) return summary;
  if (!input.replacementId)
    throw new DomainError(
      `This coach still has ${plural(work.batches.length, "batch")}, ${plural(work.sessions.length, "upcoming session")} and ${plural(work.events.length, "upcoming event")}. Choose an active replacement coach to take them over.`,
      409,
      "COACH_REPLACEMENT_REQUIRED",
    );
  // Same answer for "not a member here", "inactive" and "cannot coach": nothing about other academies leaks.
  const replacement =
    input.replacementId === input.coachId
      ? undefined
      : await lockedMembership(tx, a.academyId, input.replacementId);
  if (!canCoach(replacement))
    throw new DomainError(
      "Choose a different, active coach of this academy as the replacement.",
      422,
      "COACH_REPLACEMENT_INVALID",
    );
  const to = input.replacementId;
  summary.replacementCoachId = to;

  // The replacement must be free when the handed-over sessions and events take place.
  const [theirSessions, theirEvents] = await Promise.all([
    tx
      .select()
      .from(t.trainingSessions)
      .where(
        and(
          eq(t.trainingSessions.academyId, a.academyId),
          eq(t.trainingSessions.coachId, to),
          inArray(t.trainingSessions.status, ["PUBLISHED", "IN_PROGRESS"]),
        ),
      ),
    tx
      .select()
      .from(t.calendarEvents)
      .where(and(eq(t.calendarEvents.academyId, a.academyId), eq(t.calendarEvents.status, "SCHEDULED"))),
  ]);
  const busy = [
    ...theirSessions
      .filter((s) => s.data.startsAt)
      .map((s) => ({ startsAt: s.data.startsAt!, duration: s.data.duration })),
    ...theirEvents
      .filter((e) => e.kind !== "CLOSURE" && e.data.coachId === to)
      .map((e) => ({ startsAt: e.data.startsAt, duration: e.data.duration })),
  ];
  const incoming = [
    ...work.sessions
      .filter((s) => s.status === "PUBLISHED" && s.data.startsAt)
      .map((s) => ({ startsAt: s.data.startsAt!, duration: s.data.duration })),
    ...work.events.map((e) => ({ startsAt: e.data.startsAt, duration: e.data.duration })),
  ];
  const slot = (x: { startsAt: string; duration: number }, id: string) => ({
    id,
    ...x,
    branchId: "",
    coachId: "",
    playerIds: [],
  });
  const clashes = incoming.filter((x, i) => busy.some((b, j) => overlaps(slot(x, `in-${i}`), slot(b, `busy-${j}`))));
  if (clashes.length)
    throw new DomainError(
      `The replacement coach is already booked when ${clashes.length} of the handed-over sessions or events take place. Choose another replacement or reschedule first.`,
      409,
      "COACH_REPLACEMENT_CONFLICT",
    );

  const detail = { fromCoachId: input.coachId, toCoachId: to, reason: input.reason };
  const audit = (entityId: string, action: string, version: number) =>
    tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId,
      action,
      version,
      detail,
    });
  for (const b of work.batches) {
    await tx
      .update(t.batches)
      .set({ coachId: to })
      .where(and(eq(t.batches.academyId, a.academyId), eq(t.batches.id, b.id)));
    await audit(b.id, "batch-coach-reassigned", 1);
  }
  for (const s of work.sessions) {
    const data = { ...s.data, coachId: to };
    const version = s.version + 1;
    const [moved] = await tx
      .update(t.trainingSessions)
      .set({ coachId: to, data, version, updatedAt: new Date() })
      .where(
        and(
          eq(t.trainingSessions.academyId, a.academyId),
          eq(t.trainingSessions.id, s.id),
          eq(t.trainingSessions.version, s.version),
        ),
      )
      .returning({ id: t.trainingSessions.id });
    if (!moved)
      throw new DomainError("A session changed while the coach was being replaced. Try again.", 409);
    await tx.insert(t.revisions).values({
      academyId: a.academyId,
      sessionId: s.id,
      version,
      status: s.status,
      data,
    });
    await audit(s.id, "session-coach-reassigned", version);
  }
  for (const e of work.events) {
    const data = { ...e.data, coachId: to };
    const version = e.version + 1;
    const [moved] = await tx
      .update(t.calendarEvents)
      .set({ data, version })
      .where(
        and(
          eq(t.calendarEvents.academyId, a.academyId),
          eq(t.calendarEvents.id, e.id),
          eq(t.calendarEvents.version, e.version),
        ),
      )
      .returning({ id: t.calendarEvents.id });
    if (!moved)
      throw new DomainError("An event changed while the coach was being replaced. Try again.", 409);
    await history(tx, a, "calendar-event", e.id, version, { data, status: e.status });
    await audit(e.id, "event-coach-reassigned", version);
  }
  return summary;
}

/** Maps the database's own refusal (migration 0011 triggers) to the same codes as the checks above. */
export function coachConstraintError(error: unknown) {
  for (let e: unknown = error; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    const { code, message } = e as { code?: string; message?: string };
    if (code !== "23514") continue;
    if (message?.startsWith("COACH_REASSIGNMENT_REQUIRED"))
      return new DomainError(
        "This coach still has batch assignments. Choose an active replacement coach to take them over.",
        409,
        "COACH_REPLACEMENT_REQUIRED",
      );
    if (message?.startsWith("COACH_ASSIGNMENT_INVALID"))
      return new DomainError(
        "Choose an academy branch and active coaching staff member.",
        409,
        "COACH_ASSIGNMENT_INVALID",
      );
  }
  return null;
}
