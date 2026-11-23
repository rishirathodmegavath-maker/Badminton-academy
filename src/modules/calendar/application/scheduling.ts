import { eq } from "drizzle-orm";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { DomainError, localInstant } from "../../training/domain/rules";
import type { Tx } from "../../academy/application/access";
export type Slot = {
  id: string;
  startsAt: string;
  duration: number;
  branchId: string;
  coachId: string;
  playerIds: string[];
  closure?: boolean;
};
export function overlaps(a: Slot, b: Slot) {
  const startA = Date.parse(a.startsAt),
    startB = Date.parse(b.startsAt);
  return (
    startA < startB + b.duration * 60_000 &&
    startB < startA + a.duration * 60_000
  );
}
export function conflict(a: Slot, b: Slot) {
  if (a.id === b.id || !overlaps(a, b)) return false;
  if (a.closure || b.closure) return a.branchId === b.branchId;
  return (
    !!(a.coachId && a.coachId === b.coachId) ||
    a.playerIds.some((p) => b.playerIds.includes(p))
  );
}
/** Every slot that currently reserves time in the academy: published/in-progress sessions and scheduled events. */
export async function reservedSlots(tx: Tx, a: Actor): Promise<Slot[]> {
  const [sessions, events] = await Promise.all([
    tx
      .select()
      .from(t.trainingSessions)
      .where(eq(t.trainingSessions.academyId, a.academyId)),
    tx
      .select()
      .from(t.calendarEvents)
      .where(eq(t.calendarEvents.academyId, a.academyId)),
  ]);
  const slots: Slot[] = [
    ...sessions
      .filter(
        (s) =>
          ["PUBLISHED", "IN_PROGRESS"].includes(s.status) && s.data.startsAt,
      )
      .map((s) => ({
        id: s.id,
        startsAt: s.data.startsAt!,
        duration: s.data.duration,
        branchId: s.data.branchId,
        coachId: s.coachId,
        playerIds: s.data.roster.map((p) => p.id),
      })),
    ...events
      .filter((e) => e.status === "SCHEDULED")
      .map((e) => ({
        id: e.id,
        startsAt: e.data.startsAt,
        duration: e.data.duration,
        branchId: e.data.branchId,
        coachId: e.data.coachId,
        playerIds: e.data.playerIds,
        closure: e.kind === "CLOSURE",
      })),
  ];
  return slots;
}
/**
 * Candidates (new positions of rows written together) that clash with a reserved slot or with each other.
 * The reserved slots of the candidates themselves are ignored: those rows are the ones moving.
 */
export function clashing(candidates: Slot[], reserved: Slot[]) {
  const moving = new Set(candidates.map((c) => c.id));
  const others = reserved.filter((r) => !moving.has(r.id));
  return candidates.filter(
    (c) => others.some((o) => conflict(c, o)) || candidates.some((o) => conflict(c, o)),
  );
}
export async function ensureSlot(tx: Tx, a: Actor, slot: Slot) {
  const slots = await reservedSlots(tx, a);
  if (slots.some((other) => conflict(slot, other)))
    throw new DomainError(
      "This time conflicts with a coach, player or branch closure. Parallel sessions need distinct coaches and players.",
      409,
    );
}
export function scheduleInstant(
  localDate: string,
  localTime: string,
  duration: number,
  timezone: string,
) {
  const startsAt = localInstant(localDate, localTime, timezone);
  return {
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + duration * 60_000).toISOString(),
  };
}
