import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import type { SessionData } from "../src/modules/training/domain/types";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { saveBatch, saveMember } from "../src/modules/settings/application/service";
import { coachConstraintError } from "../src/modules/settings/application/coach-assignments";
import { mutateSession, bootstrap as trainingBootstrap } from "../src/modules/training/application/service";
import { scheduleSession } from "../src/modules/calendar/application/service";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";

/**
 * Stage 5D: coach deactivation and batch assignment integrity. Runs on embedded PGlite and, under
 * `npm run test:pg`, on real PostgreSQL 17 and 18. Every test builds its own academy.
 */
process.env.BETTER_AUTH_SECRET = "coach-assignment-test-secret-0123456789abcdef";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
let testDb: TestDatabase | undefined;
before(
  async () => {
    testDb = await provisionTestDatabase("coach-assignment");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await testDb?.cleanup();
  },
  { timeout: HOOK_TIMEOUT },
);

const db = () => database();
const ROLES = ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO", "GUARDIAN", "ADULT_PLAYER"];
const actorOf = (world: string, role: string, suffix = ""): Actor => ({
  id: `${world}-${role.toLowerCase().replace("_", "-")}${suffix}`,
  name: `Fixture ${role}${suffix}`,
  role,
  academyId: world,
  timezone: "Asia/Kolkata",
  academyName: `Academy ${world}`,
});
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Math.floor((Date.now() + offsetMs) / 60_000) * 60_000).toISOString();

/** An academy with every role, a spare coach, an inactive coach, a branch and a coached batch. */
async function world(id: string) {
  await db().insert(t.academies).values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
  await db().insert(t.academySettings).values({ academyId: id, data: defaultSettings });
  await db().insert(t.entitlements).values({
    academyId: id,
    data: { reports: true, nutrition: true, communications: true, manualVideo: true },
  });
  await db().insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Branch" });
  const people = [
    ...ROLES.map((role) => ({ actor: actorOf(id, role), active: true })),
    { actor: actorOf(id, "COACH", "-spare"), active: true },
    { actor: actorOf(id, "COACH", "-retired"), active: false },
  ];
  for (const { actor, active } of people) {
    await db().insert(t.user).values({ id: actor.id, name: actor.name, email: `${actor.id}@example.test` });
    await db().insert(t.memberships).values({ academyId: id, userId: actor.id, role: actor.role, active });
  }
  const coach = actorOf(id, "COACH");
  await db().insert(t.batches).values({ id: `${id}-batch`, academyId: id, name: "Batch", branchId: `${id}-branch`, coachId: coach.id });
  await db().insert(t.players).values({ id: `${id}-player`, academyId: id, batchId: `${id}-batch`, name: "Player" });
  await db().insert(t.profiles).values({ academyId: id, playerId: `${id}-player`, data: defaultProfile });
  return {
    id,
    owner: actorOf(id, "OWNER"),
    admin: actorOf(id, "ADMIN"),
    head: actorOf(id, "HEAD_COACH"),
    coach,
    spare: actorOf(id, "COACH", "-spare"),
    retired: actorOf(id, "COACH", "-retired"),
    finance: actorOf(id, "FINANCE"),
    guardian: actorOf(id, "GUARDIAN"),
    batchId: `${id}-batch`,
    playerId: `${id}-player`,
  };
}
type World = Awaited<ReturnType<typeof world>>;

function sessionData(w: World, coachId: string, startsAt: string | null, overrides: Partial<SessionData> = {}): SessionData {
  const when = startsAt ?? at(10 * DAY);
  return {
    title: "Footwork",
    batchId: w.batchId,
    branchId: `${w.id}-branch`,
    coachId,
    localDate: when.slice(0, 10),
    localTime: when.slice(11, 16),
    startsAt,
    timezone: "Asia/Kolkata",
    duration: 60,
    objective: "Split step",
    activities: [{ id: "a1", drillId: null, drillVersion: null, title: "Warm up", minutes: 60, cues: "", snapshot: null }],
    roster: startsAt ? [{ id: w.playerId, name: "Player" }] : [],
    attendance: {},
    observations: [],
    adjustments: [],
    progress: { index: 0, elapsed: 0, runningSince: null },
    actuals: {},
    recap: "",
    ...overrides,
  };
}
async function session(w: World, status: string, coachId: string, startsAt: string | null, overrides: Partial<SessionData> = {}) {
  const id = crypto.randomUUID();
  const data = sessionData(w, coachId, startsAt, overrides);
  await db().insert(t.trainingSessions).values({ id, academyId: w.id, coachId, batchId: w.batchId, status, version: 3, data });
  await db().insert(t.revisions).values({ academyId: w.id, sessionId: id, version: 3, status, data });
  return id;
}
async function event(w: World, coachId: string, startsAt: string, status = "SCHEDULED", kind = "EVENT", batchId = "") {
  const id = crypto.randomUUID();
  await db().insert(t.calendarEvents).values({
    id,
    academyId: w.id,
    kind,
    status,
    version: 2,
    data: {
      title: "Match day",
      localDate: startsAt.slice(0, 10),
      localTime: startsAt.slice(11, 16),
      duration: 90,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 90 * 60_000).toISOString(),
      timezone: "Asia/Kolkata",
      branchId: `${w.id}-branch`,
      coachId: kind === "CLOSURE" ? "" : coachId,
      batchId,
      playerIds: [],
      enquiryId: null,
      seriesId: null,
    },
  });
  return id;
}
const member = (w: World, who: Actor, changes: Record<string, unknown>) => ({
  id: who.id,
  name: who.name,
  email: `${who.id}@example.test`,
  role: who.role,
  active: true,
  professionalAttestation: "",
  ...changes,
});
const deactivate = (w: World, who: Actor, replacementCoachId?: string | null, by: Actor = w.owner) =>
  saveMember(by, member(w, who, { active: false, replacementCoachId }));
async function refusedWith(work: Promise<unknown>, status: number, code?: string) {
  await assert.rejects(work, (e: unknown) => {
    assert.ok(e instanceof DomainError, `expected a DomainError, got ${String(e)}`);
    assert.equal(e.status, status, e.message);
    if (code) assert.equal(e.code, code, e.message);
    return true;
  });
}
/** Everything the hand-over could touch, for "nothing changed" comparisons. */
async function state(w: World) {
  const [batches, members, sessions, revisions, events, history] = await Promise.all([
    db().select().from(t.batches).where(eq(t.batches.academyId, w.id)).orderBy(t.batches.id),
    db().select().from(t.memberships).where(eq(t.memberships.academyId, w.id)).orderBy(t.memberships.userId),
    db().select().from(t.trainingSessions).where(eq(t.trainingSessions.academyId, w.id)).orderBy(t.trainingSessions.id),
    db().select().from(t.revisions).where(eq(t.revisions.academyId, w.id)).orderBy(t.revisions.sessionId, t.revisions.version),
    db().select().from(t.calendarEvents).where(eq(t.calendarEvents.academyId, w.id)).orderBy(t.calendarEvents.id),
    db().select().from(t.recordRevisions).where(eq(t.recordRevisions.academyId, w.id)).orderBy(t.recordRevisions.id),
  ]);
  return JSON.stringify({ batches, members, sessions, revisions, events, history });
}
const sessionRow = async (id: string) => (await db().select().from(t.trainingSessions).where(eq(t.trainingSessions.id, id)))[0];
const eventRow = async (id: string) => (await db().select().from(t.calendarEvents).where(eq(t.calendarEvents.id, id)))[0];
const membership = async (w: World, who: Actor) =>
  (await db().select().from(t.memberships).where(and(eq(t.memberships.academyId, w.id), eq(t.memberships.userId, who.id))))[0];
/** The invariant itself: no batch of the academy is coached by someone who cannot coach. */
async function invariantHolds(w: World) {
  const rows = await db()
    .select({ batch: t.batches.id, active: t.memberships.active, role: t.memberships.role })
    .from(t.batches)
    .innerJoin(t.memberships, and(eq(t.memberships.academyId, t.batches.academyId), eq(t.memberships.userId, t.batches.coachId)))
    .where(eq(t.batches.academyId, w.id));
  for (const r of rows)
    assert.ok(r.active && ["OWNER", "ADMIN", "HEAD_COACH", "COACH"].includes(r.role), `batch ${r.batch} is coached by ${r.role}/${r.active}`);
}

test("deactivating a coach with no batches, sessions or events needs no replacement and is recorded as before", async () => {
  const w = await world("ca-none");
  const result = await deactivate(w, w.spare);
  assert.equal((result as { reassigned?: unknown }).reassigned, undefined);
  assert.equal((await membership(w, w.spare)).active, false);
  const events = await db().select().from(t.securityEvent).where(and(eq(t.securityEvent.academyId, w.id), eq(t.securityEvent.targetUserId, w.spare.id)));
  assert.deepEqual(events.map((e) => e.event), ["MEMBER_DEACTIVATED"]);
  const [audit] = await db().select().from(t.audit).where(and(eq(t.audit.academyId, w.id), eq(t.audit.action, "member-save")));
  assert.deepEqual(audit.detail, { role: "COACH", active: false });
  // A coach whose completed and cancelled sessions and past events are all history needs none either,
  // and that history is not touched.
  const done = await session(w, "COMPLETED", w.head.id, at(-3 * DAY));
  const cancelled = await session(w, "CANCELLED", w.head.id, null);
  const past = await event(w, w.head.id, at(-2 * DAY));
  await saveBatch(w.owner, { id: w.batchId, name: "Batch", branchId: `${w.id}-branch`, coachId: w.coach.id });
  const before = JSON.stringify([await sessionRow(done), await sessionRow(cancelled), await eventRow(past)]);
  await deactivate(w, w.head);
  assert.equal(JSON.stringify([await sessionRow(done), await sessionRow(cancelled), await eventRow(past)]), before);
});

test("a coach with batches, upcoming sessions or upcoming events cannot be deactivated without a replacement; nothing changes", async () => {
  const w = await world("ca-missing");
  await session(w, "DRAFT", w.coach.id, null);
  const before = await state(w);
  for (const replacement of [undefined, null, ""])
    await refusedWith(deactivate(w, w.coach, replacement), 409, "COACH_REPLACEMENT_REQUIRED");
  // A role that cannot coach is the same loss of coaching access.
  // (A player's own login is no longer an assignable role at all: players are under 18. It is refused before anything else, 422.)
  for (const role of ["FINANCE", "NUTRITION_PRO", "GUARDIAN"])
    await refusedWith(saveMember(w.owner, member(w, w.coach, { role, professionalAttestation: "Registered dietitian, licence 12345" })), 409, "COACH_REPLACEMENT_REQUIRED");
  await refusedWith(saveMember(w.owner, member(w, w.coach, { role: "ADULT_PLAYER" })), 422, "ADULT_PLAYERS_NOT_SUPPORTED");
  assert.equal(await state(w), before, "every refusal left batches, sessions, events and the membership as they were");
  // Only the batch: still refused.
  const lone = await world("ca-missing-batch");
  await refusedWith(deactivate(lone, lone.coach), 409, "COACH_REPLACEMENT_REQUIRED");
  // Only an upcoming event (no batch, no session): still refused.
  const ev = await world("ca-missing-event");
  await event(ev, ev.spare.id, at(5 * DAY));
  await refusedWith(deactivate(ev, ev.spare), 409, "COACH_REPLACEMENT_REQUIRED");
  await invariantHolds(w);
});

test("an invalid replacement is refused with one answer and nothing changes", async () => {
  const w = await world("ca-invalid");
  const other = await world("ca-invalid-other");
  await session(w, "PUBLISHED", w.coach.id, at(4 * DAY));
  await event(w, w.coach.id, at(6 * DAY));
  const before = await state(w);
  const otherBefore = await state(other);
  for (const replacement of [
    w.coach.id, // themself
    w.retired.id, // inactive coach
    w.finance.id, // cannot coach
    w.guardian.id, // family
    other.coach.id, // another academy's active coach
    "no-such-person",
  ])
    await refusedWith(deactivate(w, w.coach, replacement), 422, "COACH_REPLACEMENT_INVALID");
  assert.equal(await state(w), before);
  assert.equal(await state(other), otherBefore, "the other academy is untouched");
});

test("only an owner can deactivate or re-role a coach and choose the replacement; other academies cannot reach the member", async () => {
  const w = await world("ca-authz");
  const other = await world("ca-authz-other");
  const before = await state(w);
  for (const by of [w.admin, w.head, w.coach, w.finance, w.guardian])
    await refusedWith(deactivate(w, w.coach, w.spare.id, by), 403);
  // The other academy's owner: the member is not found there, and nothing moves in either academy.
  await refusedWith(saveMember(other.owner, member(w, w.coach, { active: false, replacementCoachId: other.spare.id })), 404);
  assert.equal(await state(w), before);
  // The owner's own owner membership is still protected as before.
  await refusedWith(saveMember(w.owner, member(w, w.owner, { active: false, replacementCoachId: w.spare.id })), 422);
});

test("deactivation with a valid replacement moves batches, upcoming sessions and upcoming events, and preserves history exactly", async () => {
  const w = await world("ca-handover");
  const draft = await session(w, "DRAFT", w.coach.id, null);
  const published = await session(w, "PUBLISHED", w.coach.id, at(3 * DAY));
  const stalePublished = await session(w, "PUBLISHED", w.coach.id, at(-1 * DAY));
  const completed = await session(w, "COMPLETED", w.coach.id, at(-7 * DAY), { recap: "Good session", attendance: { [w.playerId]: "PRESENT" } });
  const cancelled = await session(w, "CANCELLED", w.coach.id, at(2 * DAY), { recap: "Cancellation: rain" });
  const othersDraft = await session(w, "DRAFT", w.head.id, null);
  const upcoming = await event(w, w.coach.id, at(5 * DAY), "SCHEDULED", "TRIAL");
  const pastEvent = await event(w, w.coach.id, at(-5 * DAY));
  const cancelledEvent = await event(w, w.coach.id, at(8 * DAY), "CANCELLED");
  const othersEvent = await event(w, w.head.id, at(9 * DAY));
  const closure = await event(w, "", at(11 * DAY), "SCHEDULED", "CLOSURE");
  const untouched = [completed, cancelled, othersDraft];
  const untouchedEvents = [pastEvent, cancelledEvent, othersEvent, closure];
  const history = async () =>
    JSON.stringify([
      await Promise.all(untouched.map(sessionRow)),
      await Promise.all(untouchedEvents.map(eventRow)),
      await db().select().from(t.revisions).where(eq(t.revisions.academyId, w.id)).orderBy(t.revisions.sessionId, t.revisions.version),
    ]);
  const historyBefore = await history();

  const result = (await deactivate(w, w.coach, w.spare.id)) as {
    reassigned: { replacementCoachId: string; batches: number; sessions: number; events: number };
  };
  assert.deepEqual(result.reassigned, { replacementCoachId: w.spare.id, batches: 1, sessions: 3, events: 1 });
  assert.equal((await membership(w, w.coach)).active, false);
  assert.equal((await db().select().from(t.batches).where(eq(t.batches.id, w.batchId)))[0].coachId, w.spare.id);
  for (const id of [draft, published, stalePublished]) {
    const row = await sessionRow(id);
    assert.equal(row.coachId, w.spare.id);
    assert.equal(row.data.coachId, w.spare.id, "the plan names the new coach too");
    assert.equal(row.version, 4, "a reassignment is a new version");
    const revs = await db().select().from(t.revisions).where(eq(t.revisions.sessionId, id)).orderBy(t.revisions.version);
    assert.deepEqual(revs.map((r) => [r.version, r.status, r.data.coachId]), [[3, row.status, w.coach.id], [4, row.status, w.spare.id]], "earlier revisions keep the original coach");
  }
  const moved = await eventRow(upcoming);
  assert.equal(moved.data.coachId, w.spare.id);
  assert.equal(moved.version, 3);
  assert.equal(moved.status, "SCHEDULED");
  // Completed and cancelled sessions, past and cancelled events, and other coaches' work: byte for byte.
  const after = await history();
  const [beforeRows, beforeEvents] = JSON.parse(historyBefore);
  const [afterRows, afterEvents, afterRevisions] = JSON.parse(after);
  assert.deepEqual(afterRows, beforeRows);
  assert.deepEqual(afterEvents, beforeEvents);
  const kept = JSON.parse(historyBefore)[2];
  for (const rev of kept) assert.ok(afterRevisions.some((r: unknown) => JSON.stringify(r) === JSON.stringify(rev)), "no earlier revision was changed or removed");
  // Every move is in the audit trail with who, from whom and to whom.
  const trail = await db().select().from(t.audit).where(eq(t.audit.academyId, w.id));
  const reassignments = trail.filter((a) => a.action.endsWith("-coach-reassigned"));
  assert.deepEqual(
    reassignments.map((a) => a.action).sort(),
    ["batch-coach-reassigned", "event-coach-reassigned", "session-coach-reassigned", "session-coach-reassigned", "session-coach-reassigned"],
  );
  for (const a of reassignments) {
    assert.equal(a.actorId, w.owner.id);
    assert.deepEqual(a.detail, { fromCoachId: w.coach.id, toCoachId: w.spare.id, reason: "DEACTIVATION" });
  }
  const save = trail.find((a) => a.action === "member-save");
  assert.deepEqual(save?.detail, { role: "COACH", active: false, coachHandover: { replacementCoachId: w.spare.id, batches: 1, sessions: 3, events: 1 } });
  const security = await db().select().from(t.securityEvent).where(and(eq(t.securityEvent.academyId, w.id), eq(t.securityEvent.targetUserId, w.coach.id)));
  assert.deepEqual(security.map((e) => e.event), ["MEMBER_DEACTIVATED"]);
  await invariantHolds(w);
  // Permissions follow the assignment: the replacement now sees the batch and the moved sessions; the
  // completed session stays with the coach who held it.
  const view = await trainingBootstrap(w.spare);
  assert.deepEqual(view.batches.map((b) => b.id), [w.batchId]);
  assert.deepEqual(view.sessions.map((s) => s.id).sort(), [draft, published, stalePublished].sort());
  assert.ok(!view.sessions.some((s) => s.id === completed));
  // Reactivating the original coach gives nothing back automatically and needs no replacement.
  await saveMember(w.owner, member(w, w.coach, { active: true }));
  assert.equal((await db().select().from(t.batches).where(eq(t.batches.id, w.batchId)))[0].coachId, w.spare.id);
});

test("staff role changes: losing coaching access hands work over; keeping it moves nothing", async () => {
  const w = await world("ca-role");
  const draft = await session(w, "DRAFT", w.coach.id, null);
  const before = await state(w);
  // COACH -> HEAD_COACH / ADMIN keep coaching access: no replacement needed, nothing moves.
  await saveMember(w.owner, member(w, w.coach, { role: "HEAD_COACH" }));
  await saveMember(w.owner, member(w, w.coach, { role: "ADMIN" }));
  await saveMember(w.owner, member(w, w.coach, { role: "COACH" }));
  const after = JSON.parse(await state(w));
  const was = JSON.parse(before);
  assert.deepEqual([after.batches, after.sessions, after.events], [was.batches, was.sessions, was.events]);
  // COACH -> FINANCE (still active) loses coaching access.
  const result = (await saveMember(w.owner, member(w, w.coach, { role: "FINANCE", replacementCoachId: w.head.id }))) as { reassigned: unknown };
  assert.deepEqual(result.reassigned, { replacementCoachId: w.head.id, batches: 1, sessions: 1, events: 0 });
  const m = await membership(w, w.coach);
  assert.deepEqual([m.role, m.active], ["FINANCE", true]);
  assert.equal((await sessionRow(draft)).coachId, w.head.id);
  const [move] = await db().select().from(t.audit).where(and(eq(t.audit.academyId, w.id), eq(t.audit.action, "batch-coach-reassigned")));
  assert.equal((move.detail as { reason: string }).reason, "ROLE_CHANGE");
  const roleEvents = await db().select().from(t.securityEvent).where(and(eq(t.securityEvent.targetUserId, w.coach.id), eq(t.securityEvent.event, "MEMBER_ROLE_CHANGED")));
  assert.equal(roleEvents.length, 4, "every role change is still recorded");
  await invariantHolds(w);
  // A member who never coached (FINANCE -> GUARDIAN, deactivated) needs nothing.
  await saveMember(w.owner, member(w, w.finance, { role: "GUARDIAN", active: false }));
  // Saving an already inactive coach (no coaching access to lose) needs nothing either.
  await saveMember(w.owner, member(w, w.retired, { active: false }));
});

test("a session in progress blocks the change until it is completed or cancelled", async () => {
  const w = await world("ca-live");
  const live = await session(w, "IN_PROGRESS", w.coach.id, at(-10 * 60_000));
  const before = await state(w);
  await refusedWith(deactivate(w, w.coach, w.spare.id), 409, "COACH_SESSION_IN_PROGRESS");
  await refusedWith(saveMember(w.owner, member(w, w.coach, { role: "FINANCE", replacementCoachId: w.spare.id })), 409, "COACH_SESSION_IN_PROGRESS");
  assert.equal(await state(w), before);
  assert.equal((await sessionRow(live)).coachId, w.coach.id);
});

test("a replacement who is already booked at a handed-over time is refused; nothing changes", async () => {
  const w = await world("ca-clash");
  const when = at(4 * DAY);
  await session(w, "PUBLISHED", w.coach.id, when);
  await session(w, "PUBLISHED", w.spare.id, at(4 * DAY + 30 * 60_000));
  const before = await state(w);
  await refusedWith(deactivate(w, w.coach, w.spare.id), 409, "COACH_REPLACEMENT_CONFLICT");
  assert.equal(await state(w), before);
  // An event clash counts too; a free replacement succeeds.
  const e = await world("ca-clash-event");
  await event(e, e.coach.id, at(6 * DAY));
  await event(e, e.spare.id, at(6 * DAY + 60 * 60_000));
  await refusedWith(deactivate(e, e.coach, e.spare.id), 409, "COACH_REPLACEMENT_CONFLICT");
  await deactivate(e, e.coach, e.head.id);
  await invariantHolds(e);
});

test("transaction rollback: a failure at the last step undoes every reassignment", async () => {
  const w = await world("ca-rollback");
  await session(w, "DRAFT", w.coach.id, null);
  await session(w, "PUBLISHED", w.coach.id, at(3 * DAY));
  await event(w, w.coach.id, at(5 * DAY));
  const before = await state(w);
  // Test-only fault: the final audit row of the member change fails, after every reassignment was written.
  await db().execute(sql.raw(`create function ca_rollback_fault() returns trigger as $$
    begin raise exception 'injected failure for rollback test'; end; $$ language plpgsql`));
  await db().execute(sql.raw(`create trigger ca_rollback_fault before insert on audit_event for each row
      when (new.academy_id = 'ca-rollback' and new.action = 'member-save') execute function ca_rollback_fault()`));
  try {
    await assert.rejects(deactivate(w, w.coach, w.spare.id), /injected failure|Failed query/);
  } finally {
    await db().execute(sql.raw(`drop trigger ca_rollback_fault on audit_event`));
    await db().execute(sql.raw(`drop function ca_rollback_fault()`));
  }
  assert.equal(await state(w), before, "batches, sessions, revisions, events and the membership are exactly as before");
  assert.equal((await db().select().from(t.audit).where(and(eq(t.audit.academyId, w.id), inArray(t.audit.action, ["batch-coach-reassigned", "session-coach-reassigned", "event-coach-reassigned"])))).length, 0);
  assert.equal((await db().select().from(t.securityEvent).where(eq(t.securityEvent.academyId, w.id))).length, 0);
  // Without the fault the same request succeeds.
  await deactivate(w, w.coach, w.spare.id);
  await invariantHolds(w);
});

test("concurrent updates: assignment vs deactivation, crossed replacements, and a session edit never break the invariant or lose an edit", async () => {
  // Assigning a batch to a coach while that coach is deactivated.
  for (let round = 0; round < 3; round++) {
    const w = await world(`ca-race-${round}`);
    await db().insert(t.batches).values({ id: `${w.id}-b2`, academyId: w.id, name: "Second", branchId: `${w.id}-branch`, coachId: w.head.id });
    const results = await Promise.allSettled([
      saveBatch(w.owner, { id: `${w.id}-b2`, name: "Second", branchId: `${w.id}-branch`, coachId: w.spare.id }),
      deactivate(w, w.spare, w.head.id),
    ]);
    assert.equal(results[1].status, "fulfilled", "the deactivation always completes (with or without the new batch)");
    if (results[0].status === "rejected") assert.ok(results[0].reason instanceof DomainError, String(results[0].reason));
    assert.equal((await membership(w, w.spare)).active, false);
    await invariantHolds(w);
  }
  // Two owners each deactivate a coach and name the other as replacement: only one can succeed.
  const x = await world("ca-crossed");
  await db().insert(t.user).values({ id: "ca-crossed-owner2", name: "Second owner", email: "ca-crossed-owner2@example.test" });
  await db().insert(t.memberships).values({ academyId: x.id, userId: "ca-crossed-owner2", role: "OWNER" });
  const owner2 = { ...x.owner, id: "ca-crossed-owner2" };
  await db().insert(t.batches).values({ id: `${x.id}-b2`, academyId: x.id, name: "Second", branchId: `${x.id}-branch`, coachId: x.spare.id });
  const crossed = await Promise.allSettled([deactivate(x, x.coach, x.spare.id), deactivate(x, x.spare, x.coach.id, owner2)]);
  assert.deepEqual(crossed.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const refusal = crossed.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(refusal.reason instanceof DomainError && refusal.reason.code === "COACH_REPLACEMENT_INVALID", String(refusal.reason));
  await invariantHolds(x);
  // A coach saving their draft while the owner hands it over: serialised, versions checked, no lost edit.
  const s = await world("ca-race-edit");
  const draft = await session(s, "DRAFT", s.coach.id, null);
  const edit = mutateSession(s.coach, draft, {
    version: 3,
    action: "save",
    payload: {
      title: "Edited by the coach",
      batchId: s.batchId,
      branchId: `${s.id}-branch`,
      coachId: s.coach.id,
      localDate: "",
      localTime: "",
      duration: 60,
      objective: "Split step",
      activities: [{ id: "a1", drillId: null, drillVersion: null, title: "Warm up", minutes: 60, cues: "" }],
      adjustments: [],
    },
  });
  const handover = deactivate(s, s.coach, s.spare.id);
  const [edited, handed] = await Promise.allSettled([edit, handover]);
  assert.equal(handed.status, "fulfilled", String((handed as PromiseRejectedResult).reason));
  const row = await sessionRow(draft);
  assert.equal(row.coachId, s.spare.id, "the draft ends with the replacement");
  if (edited.status === "fulfilled") {
    assert.equal(row.data.title, "Edited by the coach", "the edit that committed first was kept");
    assert.equal(row.version, 5);
  } else {
    assert.ok(edited.reason instanceof DomainError && [404, 409].includes(edited.reason.status), String(edited.reason));
    assert.equal(row.data.title, "Footwork");
    assert.equal(row.version, 4);
  }
  await invariantHolds(s);
});

test("alternate paths: copying a session of a coach who can no longer coach is refused; batch saves need an active coach", async () => {
  const w = await world("ca-paths");
  const old = await session(w, "COMPLETED", w.coach.id, at(-4 * DAY));
  // While the coach is active, a copy is allowed (existing behaviour).
  const copy = await mutateSession(w.owner, old, { version: 3, action: "duplicate", payload: { localDate: at(20 * DAY).slice(0, 10), localTime: "07:00" } });
  assert.equal(copy.status, "DRAFT");
  await deactivate(w, w.coach, w.spare.id);
  const before = await state(w);
  await refusedWith(mutateSession(w.owner, old, { version: 3, action: "duplicate", payload: { localDate: at(21 * DAY).slice(0, 10), localTime: "07:00" } }), 409, "COACH_ASSIGNMENT_INVALID");
  await refusedWith(scheduleSession(w.owner, { id: old, version: 3, localDate: at(22 * DAY).slice(0, 10), localTime: "07:00", repeatWeeks: 2, duplicate: true }), 409, "COACH_ASSIGNMENT_INVALID");
  assert.equal(await state(w), before, "no copy was created for the inactive coach");
  // The completed session itself is untouched by the hand-over and still belongs to the original coach.
  assert.equal((await sessionRow(old)).coachId, w.coach.id);
  // Batch editor: an inactive coach, a non-coaching role and another academy's coach are refused.
  const other = await world("ca-paths-other");
  for (const coachId of [w.coach.id, w.retired.id, w.finance.id, other.coach.id])
    await refusedWith(saveBatch(w.owner, { id: w.batchId, name: "Batch", branchId: `${w.id}-branch`, coachId }), 422);
  await refusedWith(saveBatch(w.owner, { name: "New batch", branchId: `${w.id}-branch`, coachId: w.retired.id }), 422);
  await invariantHolds(w);
});

test("the database refuses what the services refuse, and its refusal maps to the same codes", async () => {
  const w = await world("ca-db");
  const caught = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return error;
    }
    assert.fail("the database accepted an inconsistent change");
  };
  const deactivation = await caught(db().update(t.memberships).set({ active: false }).where(and(eq(t.memberships.academyId, w.id), eq(t.memberships.userId, w.coach.id))));
  assert.equal(coachConstraintError(deactivation)?.code, "COACH_REPLACEMENT_REQUIRED");
  const demotion = await caught(db().update(t.memberships).set({ role: "FINANCE" }).where(and(eq(t.memberships.academyId, w.id), eq(t.memberships.userId, w.coach.id))));
  assert.equal(coachConstraintError(demotion)?.code, "COACH_REPLACEMENT_REQUIRED");
  const assignment = await caught(db().update(t.batches).set({ coachId: w.retired.id }).where(eq(t.batches.id, w.batchId)));
  assert.equal(coachConstraintError(assignment)?.code, "COACH_ASSIGNMENT_INVALID");
  const creation = await caught(db().insert(t.batches).values({ id: `${w.id}-x`, academyId: w.id, name: "X", branchId: `${w.id}-branch`, coachId: w.finance.id }));
  assert.equal(coachConstraintError(creation)?.code, "COACH_ASSIGNMENT_INVALID");
  assert.equal(coachConstraintError(new Error("unrelated")), null);
  assert.equal((await membership(w, w.coach)).active, true);
  await invariantHolds(w);
});
