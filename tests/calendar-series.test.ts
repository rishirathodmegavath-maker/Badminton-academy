import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, asc, eq } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import { defaultSettings, type CalendarData } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import { saveCalendarEvent, previewCalendarCancellation } from "../src/modules/calendar/application/service";
import { localInstant } from "../src/modules/training/domain/rules";
import { saveMember } from "../src/modules/settings/application/service";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";

/**
 * Stage 5E: recurring calendar integrity (series identity, occurrence scopes, exceptions, cancellation
 * reasons, history, concurrency, conflicts, time zones, Stage 5D compatibility). Runs on embedded PGlite
 * and, under `npm run test:pg`, on real PostgreSQL 17 and 18. Every test builds its own academy.
 */
process.env.BETTER_AUTH_SECRET = "calendar-series-test-secret-0123456789abcdef";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
let testDb: TestDatabase | undefined;
before(
  async () => {
    testDb = await provisionTestDatabase("calendar-series");
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
type Row = typeof t.calendarEvents.$inferSelect;

async function world(id: string, timezone = "Asia/Kolkata") {
  const actorOf = (role: string, suffix = ""): Actor => ({
    id: `${id}-${role.toLowerCase().replace("_", "-")}${suffix}`,
    name: `Fixture ${role}${suffix}`,
    role,
    academyId: id,
    timezone,
    academyName: `Academy ${id}`,
  });
  await db().insert(t.academies).values({ id, name: `Academy ${id}`, timezone });
  await db().insert(t.academySettings).values({ academyId: id, data: defaultSettings });
  await db().insert(t.entitlements).values({
    academyId: id,
    data: { reports: true, nutrition: true, communications: true, manualVideo: true },
  });
  await db().insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Branch" });
  const people = [...ROLES.map((r) => actorOf(r)), actorOf("COACH", "-spare")];
  for (const actor of people) {
    await db().insert(t.user).values({ id: actor.id, name: actor.name, email: `${actor.id}@example.test` });
    await db().insert(t.memberships).values({ academyId: id, userId: actor.id, role: actor.role, active: true });
  }
  const coach = actorOf("COACH");
  await db().insert(t.batches).values({ id: `${id}-batch`, academyId: id, name: "Batch", branchId: `${id}-branch`, coachId: coach.id });
  await db().insert(t.players).values({ id: `${id}-player`, academyId: id, batchId: `${id}-batch`, name: "Player" });
  await db().insert(t.profiles).values({ academyId: id, playerId: `${id}-player`, data: defaultProfile });
  const guardian = actorOf("GUARDIAN");
  await db().insert(t.guardianLinks).values({ academyId: id, playerId: `${id}-player`, userId: guardian.id, relationship: "Parent", active: true, consent: { portal: true, email: false, whatsapp: false } });
  const today = Temporal.Now.plainDateISO(timezone);
  return {
    id,
    timezone,
    today,
    branchId: `${id}-branch`,
    playerId: `${id}-player`,
    owner: actorOf("OWNER"),
    admin: actorOf("ADMIN"),
    head: actorOf("HEAD_COACH"),
    coach,
    spare: actorOf("COACH", "-spare"),
    finance: actorOf("FINANCE"),
    nutrition: actorOf("NUTRITION_PRO"),
    guardian,
    adult: actorOf("ADULT_PLAYER"),
  };
}
type World = Awaited<ReturnType<typeof world>>;
const day = (w: World, offset: number) => w.today.add({ days: offset }).toString();
const base = (w: World, changes: Record<string, unknown> = {}) => ({
  kind: "EVENT",
  title: "Weekly match play",
  localDate: day(w, 14),
  localTime: "17:00",
  duration: 60,
  branchId: w.branchId,
  coachId: w.coach.id,
  batchId: "",
  playerIds: [] as string[],
  enquiryId: null,
  repeatWeeks: 4,
  ...changes,
});
const create = (w: World, changes: Record<string, unknown> = {}, by: Actor = w.owner) =>
  saveCalendarEvent(by, base(w, changes)) as Promise<{ id: string; ids: string[]; seriesId: string | null; replayed?: boolean }>;
const rows = async (w: World) =>
  db()
    .select()
    .from(t.calendarEvents)
    .where(eq(t.calendarEvents.academyId, w.id))
    .orderBy(asc(t.calendarEvents.occurrenceDate), asc(t.calendarEvents.id));
const seriesRows = async (w: World, seriesId: string) =>
  (await rows(w)).filter((r) => r.seriesId === seriesId);
const row = async (id: string) => (await db().select().from(t.calendarEvents).where(eq(t.calendarEvents.id, id)))[0];
const series = async (id: string) => (await db().select().from(t.calendarSeries).where(eq(t.calendarSeries.id, id)))[0];
type Changes = Partial<Record<keyof CalendarData, unknown>> & Record<string, unknown>;
/** The edit form for one occurrence, as the calendar dialog submits it. */
async function edit(w: World, target: Row, changes: Changes = {}, by: Actor = w.owner) {
  return saveCalendarEvent(by, await form(target, changes)) as Promise<{
    id: string;
    ids: string[];
    seriesId: string | null;
    skipped: string[];
    skippedDates?: string[];
    replayed?: boolean;
  }>;
}
type Preview = {
  seriesId: string;
  seriesVersion: number;
  occurrenceId: string;
  scope: string;
  overwriteExceptions: boolean;
  cancel: { id: string; localDate: string; localTime: string; occurrenceDate: string }[];
  cancelCount: number;
  skipped: { id: string; localDate: string; localTime: string; occurrenceDate: string; fields: string[] }[];
  skippedCount: number;
  previewToken: string;
};
/** DEC-3: the server preview the calendar dialog requests before cancelling following / all occurrences. */
async function preview(w: World, target: Row, changes: Changes = {}, by: Actor = w.owner) {
  return previewCalendarCancellation(by, await form(target, { cancel: true, ...changes })) as Promise<Preview>;
}
/** Preview, then confirm with the preview's token (what the dialog does). */
async function cancelSeries(w: World, target: Row, changes: Changes = {}, by: Actor = w.owner) {
  const p = await preview(w, target, changes, by);
  return edit(w, target, { cancel: true, ...changes, previewToken: p.previewToken }, by);
}
async function form(target: Row, changes: Changes) {
  const s = target.seriesId ? await series(target.seriesId) : undefined;
  return {
    id: target.id,
    version: target.version,
    kind: target.kind,
    title: target.data.title,
    localDate: target.data.localDate,
    localTime: target.data.localTime,
    duration: target.data.duration,
    branchId: target.data.branchId,
    coachId: target.data.coachId,
    batchId: target.data.batchId,
    playerIds: target.data.playerIds,
    enquiryId: target.data.enquiryId,
    repeatWeeks: 1,
    cancel: target.status === "CANCELLED",
    scope: "THIS",
    seriesVersion: s?.version,
    ...changes,
  };
}
async function refusedWith(work: Promise<unknown>, status: number, pattern?: RegExp) {
  await assert.rejects(work, (e: unknown) => {
    assert.ok(e instanceof DomainError, `expected a DomainError, got ${String(e)}`);
    assert.equal(e.status, status, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });
}
const snapshot = async (w: World) =>
  JSON.stringify([
    await rows(w),
    await db().select().from(t.calendarSeries).where(eq(t.calendarSeries.academyId, w.id)).orderBy(asc(t.calendarSeries.id)),
  ]);
const revisions = async (id: string) =>
  db()
    .select()
    .from(t.recordRevisions)
    .where(and(eq(t.recordRevisions.entityId, id), eq(t.recordRevisions.kind, "calendar-event")))
    .orderBy(asc(t.recordRevisions.version));

test("creating a weekly series stores one series row and stable, unique occurrence identities", async () => {
  const w = await world("cs-create");
  const made = await create(w);
  assert.ok(made.seriesId);
  assert.equal(made.ids.length, 4);
  const occurrences = await seriesRows(w, made.seriesId!);
  assert.deepEqual(occurrences.map((r) => r.occurrenceDate), [day(w, 14), day(w, 21), day(w, 28), day(w, 35)]);
  for (const r of occurrences) {
    assert.equal(r.data.seriesId, made.seriesId, "the JSON tag mirrors the column");
    assert.equal(r.data.localDate, r.occurrenceDate);
    assert.equal(r.version, 1);
    assert.equal((await revisions(r.id)).length, 1);
  }
  const s = await series(made.seriesId!);
  assert.equal(s.version, 1);
  assert.equal(s.academyId, w.id);
  assert.deepEqual({ origin: s.data.origin, firstDate: s.data.firstDate, count: s.data.count }, { origin: "CREATED", firstDate: day(w, 14), count: 4 });
  // A one-off event has no series.
  const single = await create(w, { repeatWeeks: 1, localDate: day(w, 15), title: "One-off" });
  assert.equal(single.seriesId, null);
  const one = await row(single.id);
  assert.equal(one.seriesId, null);
  assert.equal(one.occurrenceDate, null);
  // New events cannot be created already cancelled or with a scope.
  await refusedWith(create(w, { cancel: true, localDate: day(w, 16) }), 422);
  await refusedWith(create(w, { scope: "SERIES", localDate: day(w, 16) }), 422);
});

test("this occurrence: edit changes only that occurrence, keeps it in the series and records the exception", async () => {
  const w = await world("cs-this-edit");
  const made = await create(w);
  const [first, second] = await seriesRows(w, made.seriesId!);
  const othersBefore = JSON.stringify((await seriesRows(w, made.seriesId!)).filter((r) => r.id !== second.id));
  const result = await edit(w, second, { title: "Doubles special", localTime: "18:30" });
  assert.deepEqual(result.ids, [second.id]);
  const after = await row(second.id);
  assert.equal(after.seriesId, made.seriesId, "the occurrence stays in its series");
  assert.equal(after.data.seriesId, made.seriesId);
  assert.equal(after.occurrenceDate, second.occurrenceDate, "its slot identity does not change");
  assert.equal(after.data.title, "Doubles special");
  assert.equal(after.data.localTime, "18:30");
  assert.deepEqual(after.data.overrides, ["localTime", "title"]);
  assert.notEqual(after.data.startsAt, second.data.startsAt, "the instant is recomputed");
  assert.equal(after.version, 2);
  assert.equal((await revisions(second.id)).length, 2, "the previous version stays in the history");
  assert.equal(JSON.stringify((await seriesRows(w, made.seriesId!)).filter((r) => r.id !== second.id)), othersBefore, "no other occurrence changed");
  assert.equal((await series(made.seriesId!)).version, 1, "an individual change is not a series change");
  // Moving it to another date keeps its occurrence date (slot identity).
  await edit(w, after, { localDate: day(w, 23) });
  const moved = await row(second.id);
  assert.equal(moved.data.localDate, day(w, 23));
  assert.equal(moved.occurrenceDate, second.occurrenceDate);
  assert.deepEqual(moved.data.overrides, ["localDate", "localTime", "title"]);
  void first;
});

test("this occurrence: cancellation needs a reason, keeps the row and its series, frees the slot and can be restored", async () => {
  const w = await world("cs-this-cancel");
  const made = await create(w);
  const occurrences = await seriesRows(w, made.seriesId!);
  const target = occurrences[1];
  const before = await snapshot(w);
  await refusedWith(edit(w, target, { cancel: true }), 422, /reason/);
  await refusedWith(edit(w, target, { cancel: true, reason: " a " }), 422, /reason/);
  assert.equal(await snapshot(w), before, "a refused cancellation changes nothing");
  await edit(w, target, { cancel: true, reason: "Hall booked for exams" });
  const cancelled = await row(target.id);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.seriesId, made.seriesId);
  assert.equal(cancelled.data.cancellation?.reason, "Hall booked for exams");
  assert.equal(cancelled.data.cancellation?.scope, "THIS");
  assert.deepEqual(cancelled.data.overrides, ["status"]);
  for (const other of occurrences.filter((r) => r.id !== target.id)) assert.equal((await row(other.id)).status, "SCHEDULED");
  // The slot is free: the same coach can now be booked at that time.
  await create(w, { repeatWeeks: 1, localDate: target.data.localDate, title: "Replacement clinic" });
  // Restoring it is refused while the slot is taken, then allowed once it is free again.
  await refusedWith(edit(w, cancelled, { cancel: false }), 409, /conflicts/);
  const clash = (await rows(w)).find((r) => r.data.title === "Replacement clinic")!;
  await edit(w, clash, { cancel: true, reason: "Clinic moved" });
  await edit(w, await row(target.id), { cancel: false });
  const restored = await row(target.id);
  assert.equal(restored.status, "SCHEDULED");
  assert.equal(restored.data.cancellation, undefined);
  assert.equal(restored.data.overrides, undefined, "restoring an individual cancellation clears the exception");
  const history = await revisions(target.id);
  assert.equal(history.length, 3);
  assert.equal((history[1].data as { data: CalendarData }).data.cancellation?.reason, "Hall booked for exams", "the reason stays in the history");
  // A one-off event also needs a reason.
  const single = await create(w, { repeatWeeks: 1, localDate: day(w, 50), title: "One-off" });
  await refusedWith(edit(w, await row(single.id), { cancel: true }), 422, /reason/);
});

test("entire series: changes every upcoming occurrence, leaves started ones and individual changes alone", async () => {
  const w = await world("cs-series");
  // Two occurrences in the past, four upcoming.
  const made = await create(w, { localDate: day(w, -9), repeatWeeks: 6 });
  const all = await seriesRows(w, made.seriesId!);
  const [past1, past2, up1, up2, up3, up4] = all;
  await edit(w, up2, { title: "Exception title" });
  const pastBefore = JSON.stringify([await row(past1.id), await row(past2.id)]);
  const result = await edit(w, await row(up1.id), { scope: "SERIES", title: "Match play (new format)", localTime: "18:00", duration: 90 });
  assert.deepEqual(result.ids.sort(), [up1.id, up2.id, up3.id, up4.id].sort());
  assert.deepEqual(result.skipped, [up2.id]);
  assert.equal(JSON.stringify([await row(past1.id), await row(past2.id)]), pastBefore, "past occurrences are history");
  for (const id of [up1.id, up3.id, up4.id]) {
    const r = await row(id);
    assert.equal(r.data.title, "Match play (new format)");
    assert.equal(r.data.localTime, "18:00");
    assert.equal(r.data.duration, 90);
    assert.equal(r.data.overrides, undefined);
    assert.equal(r.seriesId, made.seriesId);
  }
  const exception = await row(up2.id);
  assert.equal(exception.data.title, "Exception title", "an individually changed field is kept");
  assert.equal(exception.data.localTime, "18:00", "fields it did not change follow the series");
  assert.deepEqual(exception.data.overrides, ["title"]);
  assert.equal((await series(made.seriesId!)).version, 2);
  const [audit] = await db().select().from(t.audit).where(and(eq(t.audit.entityId, made.seriesId!), eq(t.audit.action, "calendar-series-change")));
  assert.equal((audit.detail as { scope: string }).scope, "SERIES");
  assert.deepEqual((audit.detail as { skipped: string[] }).skipped, [up2.id]);
});

test("explicit overwrite: individually changed occurrences take the series values and stop being exceptions", async () => {
  const w = await world("cs-overwrite");
  const made = await create(w);
  const [a, b] = await seriesRows(w, made.seriesId!);
  await edit(w, b, { title: "Exception title", localTime: "19:00" });
  const result = await edit(w, await row(a.id), { scope: "SERIES", title: "Unified title", overwriteExceptions: true });
  assert.deepEqual(result.skipped, []);
  const overwritten = await row(b.id);
  assert.equal(overwritten.data.title, "Unified title");
  assert.equal(overwritten.data.localTime, "19:00", "fields not in the change keep their individual value");
  assert.deepEqual(overwritten.data.overrides, ["localTime"]);
});

test("this and following: splits the series at the occurrence; earlier and past occurrences keep the old series", async () => {
  const w = await world("cs-following");
  const made = await create(w, { localDate: day(w, -6), repeatWeeks: 6 });
  const [past, up1, up2, up3, up4, up5] = await seriesRows(w, made.seriesId!);
  await edit(w, up4, { title: "Tail exception" });
  await edit(w, await row(up5.id), { cancel: true, reason: "Public holiday" });
  const headBefore = JSON.stringify([await row(past.id), await row(up1.id)]);
  const result = await edit(w, await row(up2.id), { scope: "FOLLOWING", localTime: "16:00", localDate: Temporal.PlainDate.from(up2.data.localDate).add({ days: 1 }).toString() });
  assert.ok(result.seriesId && result.seriesId !== made.seriesId, "the following occurrences form a new series");
  assert.equal(JSON.stringify([await row(past.id), await row(up1.id)]), headBefore, "earlier occurrences are untouched");
  const tail = await seriesRows(w, result.seriesId!);
  assert.deepEqual(tail.map((r) => r.id), [up2.id, up3.id, up4.id, up5.id]);
  const split = await series(result.seriesId!);
  assert.equal(split.splitFrom, made.seriesId);
  assert.equal(split.data.origin, "SPLIT");
  for (const r of tail) {
    assert.equal(r.data.seriesId, result.seriesId);
    assert.equal(r.occurrenceDate, [up2, up3, up4, up5].find((o) => o.id === r.id)!.occurrenceDate, "occurrence dates are kept");
  }
  // Date shift of one day and new time for the regular occurrences.
  for (const [r, o] of [[await row(up2.id), up2], [await row(up3.id), up3], [await row(up4.id), up4]] as const) {
    assert.equal(r.data.localTime, "16:00");
    assert.equal(r.data.localDate, Temporal.PlainDate.from(o.data.localDate).add({ days: 1 }).toString());
  }
  assert.equal((await row(up4.id)).data.title, "Tail exception", "the exception moved with its series and kept its title");
  const cancelled = await row(up5.id);
  assert.equal(cancelled.status, "CANCELLED", "a cancelled occurrence stays cancelled");
  assert.equal(cancelled.data.localTime, "17:00");
  // The two parts are independent from now on.
  assert.deepEqual((await seriesRows(w, made.seriesId!)).map((r) => r.id), [past.id, up1.id]);
  await edit(w, await row(up1.id), { scope: "SERIES", title: "Old part only" });
  assert.equal((await row(up1.id)).data.title, "Old part only");
  assert.equal((await row(up3.id)).data.title, "Weekly match play");
  await edit(w, await row(up3.id), { scope: "SERIES", title: "New part only" });
  assert.equal((await row(up1.id)).data.title, "Old part only");
  assert.equal((await row(up2.id)).data.title, "New part only");
  // From the first upcoming occurrence of a series with nothing before it, "following" does not split.
  const fresh = await create(w, { localDate: day(w, 60), repeatWeeks: 3, title: "Fresh" });
  const [f1] = await seriesRows(w, fresh.seriesId!);
  const unsplit = await edit(w, f1, { scope: "FOLLOWING", title: "Fresh renamed" });
  assert.equal(unsplit.seriesId, fresh.seriesId);
});

test("series cancellation: reason required, upcoming occurrences cancelled, exceptions kept unless overwritten, past untouched", async () => {
  const w = await world("cs-series-cancel");
  const made = await create(w, { localDate: day(w, -6), repeatWeeks: 5 });
  const [past, up1, up2, up3, up4] = await seriesRows(w, made.seriesId!);
  await edit(w, up3, { title: "Final" });
  const before = await snapshot(w);
  await refusedWith(edit(w, await row(up1.id), { scope: "SERIES", cancel: true }), 422, /reason/);
  await refusedWith(edit(w, await row(up1.id), { scope: "SERIES", cancel: true, reason: "Season over", title: "x and y" }), 422, /without changing/);
  // DEC-3: a series cancellation without a server preview is refused.
  await refusedWith(edit(w, await row(up2.id), { scope: "FOLLOWING", cancel: true, reason: "Season over" }), 422, /Review which occurrences/);
  assert.equal(await snapshot(w), before);
  const result = await cancelSeries(w, await row(up2.id), { scope: "FOLLOWING", reason: "Season over" });
  assert.deepEqual(result.ids.sort(), [up2.id, up4.id].sort());
  assert.deepEqual(result.skipped, [up3.id]);
  assert.equal(result.seriesId, made.seriesId, "cancelling does not split");
  assert.equal((await row(past.id)).status, "SCHEDULED");
  assert.equal((await row(up1.id)).status, "SCHEDULED");
  assert.equal((await row(up3.id)).status, "SCHEDULED", "an individually changed occurrence is kept");
  for (const id of [up2.id, up4.id]) {
    const r = await row(id);
    assert.equal(r.status, "CANCELLED");
    assert.deepEqual({ reason: r.data.cancellation?.reason, scope: r.data.cancellation?.scope }, { reason: "Season over", scope: "FOLLOWING" });
    assert.equal(r.seriesId, made.seriesId);
  }
  await cancelSeries(w, await row(up1.id), { scope: "SERIES", reason: "Coach injured", overwriteExceptions: true });
  assert.equal((await row(up3.id)).status, "CANCELLED", "with overwrite the exception is cancelled too");
  assert.equal((await row(past.id)).status, "SCHEDULED", "a past occurrence is never cancelled");
  // A series-cancelled occurrence restored on its own becomes an exception.
  await edit(w, await row(up4.id), { cancel: false });
  assert.deepEqual((await row(up4.id)).data.overrides, ["status"]);
  // Series changes from a cancelled occurrence are refused (restore it first).
  await refusedWith(edit(w, await row(up2.id), { scope: "SERIES", cancel: false, title: "Back on" }), 422, /cancelled/);
  // Every row is kept.
  assert.equal((await seriesRows(w, made.seriesId!)).length, 5);
});

test("DEC-1: started occurrences of a recurring series are history: they cannot be changed, cancelled, restored or previewed in any scope", async () => {
  const w = await world("cs-past");
  const made = await create(w, { localDate: day(w, -14), repeatWeeks: 4 });
  const [past] = await seriesRows(w, made.seriesId!);
  const before = await snapshot(w);
  for (const scope of ["THIS", "FOLLOWING", "SERIES"]) {
    await refusedWith(edit(w, past, { scope, title: "Rewritten" }), 409, /already started/);
    await refusedWith(edit(w, past, { scope, cancel: true, reason: "Too late" }), 409, /already started/);
  }
  await refusedWith(preview(w, past, { scope: "SERIES", reason: "Too late" }), 409, /already started/);
  assert.equal(await snapshot(w), before);
  // An occurrence in progress counts as started.
  const now = Temporal.Now.zonedDateTimeISO(w.timezone).subtract({ minutes: 10 });
  // (Another coach, so it cannot clash with today's occurrence of the series above.)
  const running = await create(w, { repeatWeeks: 2, localDate: now.toPlainDate().toString(), localTime: now.toPlainTime().toString().slice(0, 5), duration: 60, coachId: w.spare.id, title: "Running series" });
  const [live] = await seriesRows(w, running.seriesId!);
  const liveBefore = await snapshot(w);
  await refusedWith(edit(w, live, { title: "Renamed live" }), 409, /already started/);
  await refusedWith(edit(w, live, { cancel: true, reason: "Rain stopped play" }), 409, /already started/);
  assert.equal(await snapshot(w), liveBefore);
  // A started series occurrence that is cancelled cannot be restored either (state prepared directly).
  await db().update(t.calendarEvents).set({ status: "CANCELLED" }).where(eq(t.calendarEvents.id, past.id));
  const cancelledPast = await row(past.id);
  const restoreBefore = await snapshot(w);
  await refusedWith(edit(w, cancelledPast, { cancel: false }), 409, /already started/);
  assert.equal(await snapshot(w), restoreBefore);
});

test("DEC-1: a started one-off event can be corrected, cancelled and restored, but keeps its coach, branch and batch", async () => {
  const w = await world("cs-dec1");
  await db().insert(t.branches).values({ id: `${w.id}-branch-2`, academyId: w.id, name: "Branch 2" });
  await db().insert(t.batches).values({ id: `${w.id}-batch-2`, academyId: w.id, name: "Batch 2", branchId: w.branchId, coachId: w.spare.id });
  // A past one-off batch event (participants derived from the batch at the time) and one running now.
  const made = await create(w, { repeatWeeks: 1, localDate: day(w, -3), batchId: `${w.id}-batch`, title: "Past batch clinic" });
  const original = await row(made.id);
  assert.equal(original.seriesId, null);
  assert.deepEqual(original.data.playerIds, [w.playerId]);
  // Corrections of the other details are accepted, recorded in the history and keep the stored instant.
  await edit(w, original, { title: "Past batch clinic (doubles)" });
  let current = await row(made.id);
  assert.equal(current.data.title, "Past batch clinic (doubles)");
  assert.equal(current.version, 2);
  assert.equal(current.data.startsAt, original.data.startsAt, "a title correction does not re-time the event");
  assert.equal(current.data.overrides, undefined, "a one-off event has no series exceptions");
  assert.equal((await revisions(made.id)).length, 2);
  await edit(w, current, { localTime: "18:00", duration: 75 });
  current = await row(made.id);
  assert.equal(current.data.localTime, "18:00");
  assert.notEqual(current.data.startsAt, original.data.startsAt, "a time correction re-times it");
  // Coach, branch and batch are historical attribution and stay as they were (each refused on its own).
  const frozen = await snapshot(w);
  await refusedWith(edit(w, current, { coachId: w.spare.id, batchId: "" }), 422, /keeps the coach, branch and batch/);
  await refusedWith(edit(w, current, { coachId: w.spare.id }), 422, /keeps the coach, branch and batch/);
  await refusedWith(edit(w, current, { branchId: `${w.id}-branch-2`, batchId: "" }), 422, /keeps the coach, branch and batch/);
  await refusedWith(edit(w, current, { branchId: `${w.id}-branch-2` }), 422, /keeps the coach, branch and batch/);
  await refusedWith(edit(w, current, { batchId: "" }), 422, /keeps the coach, branch and batch/);
  await refusedWith(edit(w, current, { batchId: `${w.id}-batch-2`, coachId: w.spare.id }), 422, /keeps the coach, branch and batch/);
  // Not a series: no following / series scope, no series preview.
  await refusedWith(edit(w, current, { scope: "SERIES", title: "Series?" }), 422, /not part of a recurring series/);
  await refusedWith(preview(w, current, { scope: "SERIES", reason: "Rain" }), 422, /not part of a recurring series/);
  // Version, role and academy rules still apply.
  await refusedWith(edit(w, original, { title: "Stale" }), 409, /changed/);
  const other = await world("cs-dec1-other");
  await refusedWith(edit(w, current, { title: "Hijack" }, other.owner), 404);
  for (const by of [w.coach, w.finance, w.nutrition, w.guardian, w.adult])
    await refusedWith(edit(w, current, { title: "Not allowed" }, by), 403);
  assert.equal(await snapshot(w), frozen, "refused corrections change nothing");
  // Cancellation needs a reason; restoration brings it back (cancellation note removed, history kept).
  await refusedWith(edit(w, current, { cancel: true }), 422, /reason/);
  await edit(w, current, { cancel: true, reason: "Recorded by mistake" });
  current = await row(made.id);
  assert.equal(current.status, "CANCELLED");
  assert.deepEqual({ reason: current.data.cancellation?.reason, scope: current.data.cancellation?.scope }, { reason: "Recorded by mistake", scope: "THIS" });
  assert.equal(current.data.coachId, w.coach.id);
  await edit(w, current, { cancel: false });
  current = await row(made.id);
  assert.equal(current.status, "SCHEDULED");
  assert.equal(current.data.cancellation, undefined);
  assert.equal((await revisions(made.id)).length, 5);
  // Stage 5D: deactivating the coach (with a replacement) moves only upcoming events; this one keeps its coach.
  const member = (changes: Record<string, unknown>) => ({ id: w.coach.id, name: w.coach.name, email: `${w.coach.id}@example.test`, role: "COACH", active: true, professionalAttestation: "", ...changes });
  await saveMember(w.owner, member({ active: false, replacementCoachId: w.spare.id }));
  current = await row(made.id);
  assert.equal(current.data.coachId, w.coach.id, "historical coach attribution is preserved");
  // It can still be corrected although its coach is now inactive and its batch has a new coach, and its
  // participants are not re-derived from today's batch roster.
  await db().insert(t.players).values({ id: `${w.id}-player-new`, academyId: w.id, batchId: `${w.id}-batch`, name: "Joined later" });
  await db().insert(t.profiles).values({ academyId: w.id, playerId: `${w.id}-player-new`, data: defaultProfile });
  await edit(w, current, { title: "Past batch clinic (final)" });
  current = await row(made.id);
  assert.equal(current.data.title, "Past batch clinic (final)");
  assert.deepEqual({ coachId: current.data.coachId, branchId: current.data.branchId, batchId: current.data.batchId }, { coachId: w.coach.id, branchId: w.branchId, batchId: `${w.id}-batch` });
  assert.deepEqual(current.data.playerIds, [w.playerId]);
  // ...but it can never be handed to the replacement (or anyone) after the fact.
  await refusedWith(edit(w, current, { coachId: w.spare.id }), 422, /keeps the coach, branch and batch/);
  // Participants can be corrected; an unknown player is refused.
  await refusedWith(edit(w, current, { playerIds: [w.playerId, "no-such-player"] }), 404);
  await edit(w, current, { playerIds: [w.playerId, `${w.id}-player-new`] });
  assert.deepEqual((await row(made.id)).data.playerIds.sort(), [w.playerId, `${w.id}-player-new`].sort());
  // A one-off event in progress can be corrected too.
  const now = Temporal.Now.zonedDateTimeISO(w.timezone).subtract({ minutes: 10 });
  const live = await create(w, { repeatWeeks: 1, localDate: now.toPlainDate().toString(), localTime: now.toPlainTime().toString().slice(0, 5), duration: 60, coachId: w.spare.id, title: "Running now" });
  await edit(w, await row(live.id), { title: "Running now (renamed)" });
  assert.equal((await row(live.id)).data.title, "Running now (renamed)");
  // An upcoming one-off event keeps the normal rules: its coach can be changed to another active coach.
  const upcoming = await create(w, { repeatWeeks: 1, localDate: day(w, 20), coachId: w.spare.id, title: "Upcoming" });
  await edit(w, await row(upcoming.id), { coachId: w.head.id });
  assert.equal((await row(upcoming.id)).data.coachId, w.head.id);
});

test("completed and in-progress training sessions are never touched by series operations", async () => {
  const w = await world("cs-sessions");
  const sessionIds = [];
  for (const status of ["COMPLETED", "IN_PROGRESS", "PUBLISHED"]) {
    const id = crypto.randomUUID();
    sessionIds.push(id);
    await db().insert(t.trainingSessions).values({
      id,
      academyId: w.id,
      coachId: w.coach.id,
      batchId: `${w.id}-batch`,
      status,
      data: {
        title: "Footwork", batchId: `${w.id}-batch`, branchId: w.branchId, coachId: w.coach.id,
        localDate: day(w, -2), localTime: "07:00", startsAt: null, timezone: w.timezone, duration: 60,
        activities: [], roster: [], attendance: {}, observations: [], actuals: {}, recap: "",
        progress: { index: 0, elapsed: 0, runningSince: null },
      } as never,
    });
  }
  const sessionsBefore = JSON.stringify(await db().select().from(t.trainingSessions).where(eq(t.trainingSessions.academyId, w.id)).orderBy(asc(t.trainingSessions.id)));
  const made = await create(w, { localDate: day(w, -1), repeatWeeks: 3 });
  const [, up] = await seriesRows(w, made.seriesId!);
  await edit(w, up, { scope: "SERIES", title: "Renamed" });
  await cancelSeries(w, await row(up.id), { scope: "SERIES", reason: "Season over" });
  assert.equal(JSON.stringify(await db().select().from(t.trainingSessions).where(eq(t.trainingSessions.academyId, w.id)).orderBy(asc(t.trainingSessions.id))), sessionsBefore);
});

test("series identity survives individual edits, cancellations and restores; the series still reaches every occurrence", async () => {
  const w = await world("cs-identity");
  const made = await create(w, { repeatWeeks: 5 });
  const [a, b, c, d, e] = await seriesRows(w, made.seriesId!);
  await edit(w, a, { title: "First changed" });
  await edit(w, b, { cancel: true, reason: "Rain" });
  await edit(w, await row(b.id), { cancel: false });
  await edit(w, c, { localTime: "19:00" });
  await edit(w, await row(c.id), { localTime: "17:00" });
  const members = await seriesRows(w, made.seriesId!);
  assert.equal(members.length, 5, "no occurrence ever left the series");
  assert.ok(members.every((r) => r.data.seriesId === made.seriesId));
  const result = await edit(w, await row(d.id), { scope: "SERIES", duration: 75 });
  assert.deepEqual(result.ids.sort(), [a.id, b.id, c.id, d.id, e.id].sort());
  assert.ok((await seriesRows(w, made.seriesId!)).every((r) => r.data.duration === 75));
});

test("idempotency: a retried creation returns the first result; a retried series change is refused, not applied twice", async () => {
  const w = await world("cs-idem");
  const requestId = crypto.randomUUID();
  const first = await create(w, { requestId });
  const again = await create(w, { requestId });
  assert.equal(again.replayed, true);
  assert.deepEqual(again.ids, first.ids);
  assert.equal(again.seriesId, first.seriesId);
  assert.equal((await rows(w)).length, 4, "no duplicate occurrences");
  await refusedWith(create(w, { requestId, title: "Something else", localDate: day(w, 40) }), 409, /already used/);
  const single = crypto.randomUUID();
  const one = await create(w, { requestId: single, repeatWeeks: 1, localDate: day(w, 3) });
  const oneAgain = await create(w, { requestId: single, repeatWeeks: 1, localDate: day(w, 3) });
  assert.deepEqual(oneAgain.ids, one.ids);
  assert.equal((await rows(w)).length, 5);
  // Another academy cannot reuse (or probe) the request id.
  const other = await world("cs-idem-other");
  await refusedWith(create(other, { requestId }), 409, /already used/);
  // A retried series change (same versions) is refused, so a date shift is never applied twice.
  const [o1] = await seriesRows(w, first.seriesId!);
  const shift = async () => edit(w, o1, { scope: "SERIES", localDate: Temporal.PlainDate.from(o1.data.localDate).add({ days: 1 }).toString() });
  await shift();
  const shifted = await snapshot(w);
  await refusedWith(shift(), 409);
  assert.equal(await snapshot(w), shifted);
});

test("concurrency: two simultaneous series changes from the same version; exactly one is applied", async () => {
  const w = await world("cs-race");
  const made = await create(w);
  const [o1, o2] = await seriesRows(w, made.seriesId!);
  const settle = (p: Promise<unknown>) => p.then(() => "ok", (e: DomainError) => e.status);
  const outcomes = await Promise.all([
    settle(edit(w, o1, { scope: "SERIES", title: "From admin one" })),
    settle(edit(w, o2, { scope: "SERIES", title: "From admin two" }, w.admin)),
  ]);
  assert.deepEqual(outcomes.sort(), [409, "ok"].sort((x, y) => String(x).localeCompare(String(y))));
  const titles = new Set((await seriesRows(w, made.seriesId!)).map((r) => r.data.title));
  assert.equal(titles.size, 1, "the series is never half one change and half the other");
  assert.equal((await series(made.seriesId!)).version, 2);
  // An individual change racing a series change: both are serialised; the loser is refused, never lost.
  const [p1] = await seriesRows(w, made.seriesId!);
  const race = await Promise.all([
    settle(edit(w, p1, { title: "Individual" })),
    settle(edit(w, p1, { scope: "SERIES", title: "Series" })),
  ]);
  assert.ok(race.includes("ok") && race.includes(409), JSON.stringify(race));
});

test("version conflicts: stale occurrence, stale series and missing series versions are refused", async () => {
  const w = await world("cs-versions");
  const made = await create(w);
  const [o1, o2] = await seriesRows(w, made.seriesId!);
  await edit(w, o1, { title: "Changed" });
  const before = await snapshot(w);
  await refusedWith(edit(w, o1, { title: "Stale" }), 409, /changed/);
  await refusedWith(edit(w, o2, { scope: "SERIES", title: "No version", seriesVersion: undefined }), 409, /Reload/);
  await refusedWith(edit(w, o2, { scope: "SERIES", title: "Old version", seriesVersion: 0 }), 409);
  await refusedWith(edit(w, o2, { scope: "SERIES", title: "Wrong", version: 7 }), 409);
  assert.equal(await snapshot(w), before);
});

test("scheduling conflicts: a series change that would clash anywhere is refused as a whole, naming the dates", async () => {
  const w = await world("cs-conflicts");
  const made = await create(w);
  const occurrences = await seriesRows(w, made.seriesId!);
  // The same coach is busy at 18:00 on the third week.
  await create(w, { repeatWeeks: 1, localDate: occurrences[2].data.localDate, localTime: "18:00", title: "Coach meeting" });
  const before = await snapshot(w);
  await refusedWith(edit(w, occurrences[0], { scope: "SERIES", localTime: "18:00" }), 409, new RegExp(`conflicts[\\s\\S]*|${occurrences[2].data.localDate}`));
  await assert.rejects(edit(w, occurrences[0], { scope: "SERIES", localTime: "18:00" }), new RegExp(occurrences[2].data.localDate));
  assert.equal(await snapshot(w), before, "nothing was changed");
  // Creating a series over a closure is refused as a whole too.
  await create(w, { kind: "CLOSURE", title: "Closed", coachId: "", repeatWeeks: 1, localDate: day(w, 70) });
  await refusedWith(create(w, { localDate: day(w, 56), repeatWeeks: 4, title: "Over closure" }), 409, /conflicts/);
  assert.equal((await rows(w)).filter((r) => r.data.title === "Over closure").length, 0);
  // Shifting the whole series by a week does not clash with its own old positions.
  await edit(w, (await seriesRows(w, made.seriesId!))[0], { scope: "SERIES", localDate: Temporal.PlainDate.from(occurrences[0].data.localDate).add({ days: 7 }).toString() });
});

test("academy isolation and role authorization", async () => {
  const w = await world("cs-iso-a");
  const other = await world("cs-iso-b");
  const made = await create(w);
  const [o1] = await seriesRows(w, made.seriesId!);
  const before = await snapshot(w);
  // Another academy's owner cannot see or change the occurrence or its series.
  await refusedWith(edit(w, o1, { title: "Hijack" }, other.owner), 404);
  await refusedWith(edit(w, o1, { scope: "SERIES", title: "Hijack" }, other.owner), 404);
  for (const by of [w.coach, w.finance, w.nutrition, w.guardian, w.adult]) {
    await refusedWith(edit(w, o1, { scope: "SERIES", title: "Not allowed" }, by), 403);
    await refusedWith(create(w, { localDate: day(w, 90) }, by), 403);
  }
  assert.equal(await snapshot(w), before);
  for (const by of [w.admin, w.head]) await edit(w, await row(o1.id), { title: `By ${by.role}` }, by);
  // Payload: series versions only for the roles that can change events; families get the old event shape.
  const ops = await bootstrapAcademy(w.owner);
  assert.deepEqual(ops.calendarSeries.map((s) => s.id), [made.seriesId]);
  assert.equal((await bootstrapAcademy(other.owner)).calendarSeries.length, 0);
  for (const by of [w.coach, w.finance, w.nutrition, w.guardian]) assert.equal((await bootstrapAcademy(by)).calendarSeries.length, 0, by.role);
  await create(w, { repeatWeeks: 1, localDate: day(w, 91), playerIds: [w.playerId], title: "Family day" });
  const family = await bootstrapAcademy(w.guardian);
  const familyEvent = family.events.find((e) => e.data.title === "Family day")!;
  assert.deepEqual(Object.keys(familyEvent).sort(), ["academyId", "data", "id", "kind", "status", "version"]);
  assert.ok(!("overrides" in familyEvent.data) && !("cancellation" in familyEvent.data));
});

test("time zones: series keep local wall time across daylight saving, refuse missing local times, and use local dates", async () => {
  const ny = await world("cs-tz-ny", "America/New_York");
  // The next second Sunday of March (start of US daylight saving).
  let year = ny.today.year;
  const dstStart = (y: number) => {
    const march = Temporal.PlainDate.from({ year: y, month: 3, day: 1 });
    return march.add({ days: ((7 - march.dayOfWeek) % 7) + 7 });
  };
  if (Temporal.PlainDate.compare(dstStart(year), ny.today.add({ days: 14 })) <= 0) year += 1;
  const sunday = dstStart(year);
  const start = sunday.subtract({ weeks: 2 }).toString();
  const made = await create(ny, { localDate: start, localTime: "10:00", repeatWeeks: 4 });
  const occurrences = await seriesRows(ny, made.seriesId!);
  assert.ok(occurrences.every((r) => r.data.localTime === "10:00" && r.data.timezone === "America/New_York"));
  const offsets = occurrences.map((r) => Temporal.Instant.from(r.data.startsAt).toZonedDateTimeISO("UTC").hour);
  assert.deepEqual(offsets, [15, 15, 14, 14], "the UTC instant moves by an hour; the local time does not");
  // 02:30 does not exist on the transition Sunday: the whole series is refused, naming the date.
  await refusedWith(create(ny, { localDate: start, localTime: "02:30", repeatWeeks: 4, title: "Night" }), 422, new RegExp(sunday.toString()));
  assert.equal((await rows(ny)).filter((r) => r.data.title === "Night").length, 0);
  const before = await snapshot(ny);
  await refusedWith(edit(ny, occurrences[0], { scope: "SERIES", localTime: "02:30" }), 422, new RegExp(sunday.toString()));
  assert.equal(await snapshot(ny), before, "nothing was changed");
  // Local date, not UTC date: 01:00 in India is the previous day in UTC.
  const india = await world("cs-tz-in");
  const early = await create(india, { localTime: "01:00", repeatWeeks: 2, localDate: day(india, 10) });
  const [e1] = await seriesRows(india, early.seriesId!);
  assert.equal(e1.occurrenceDate, day(india, 10));
  assert.equal(e1.data.startsAt.slice(0, 10), day(india, 9));
  // An academy timezone change does not move stored occurrences until they are re-timed.
  const moved = { ...india.owner, timezone: "Asia/Dubai" };
  await edit(india, e1, { title: "Renamed only" }, moved);
  assert.equal((await row(e1.id)).data.timezone, "Asia/Kolkata");
  assert.equal((await row(e1.id)).data.startsAt, e1.data.startsAt);
  await edit(india, await row(e1.id), { localTime: "02:00" }, moved);
  assert.equal((await row(e1.id)).data.timezone, "Asia/Dubai");
});

test("Stage 5D compatibility: deactivating a coach hands series occurrences to the replacement without breaking series identity", async () => {
  const w = await world("cs-5d");
  const made = await create(w, { localDate: day(w, -6), repeatWeeks: 4, batchId: `${w.id}-batch` });
  const [past, up1, up2, up3] = await seriesRows(w, made.seriesId!);
  await edit(w, up2, { title: "Exception" });
  // A series change cannot assign an inactive or non-coaching member.
  await refusedWith(edit(w, await row(up1.id), { scope: "SERIES", coachId: w.finance.id, batchId: "" }), 422, /active coach/);
  // Deactivation without a replacement is refused (Stage 5D), with one it moves the upcoming occurrences.
  const member = (changes: Record<string, unknown>) => ({ id: w.coach.id, name: w.coach.name, email: `${w.coach.id}@example.test`, role: "COACH", active: true, professionalAttestation: "", ...changes });
  await refusedWith(saveMember(w.owner, member({ active: false })), 409);
  await saveMember(w.owner, member({ active: false, replacementCoachId: w.spare.id }));
  for (const o of [up1, up2, up3]) {
    const r = await row(o.id);
    assert.equal(r.data.coachId, w.spare.id);
    assert.equal(r.seriesId, made.seriesId, "still in its series");
    assert.equal(r.data.seriesId, made.seriesId);
  }
  assert.equal((await row(past.id)).data.coachId, w.coach.id, "the past occurrence keeps its historical coach");
  assert.equal((await row(up1.id)).data.overrides, undefined, "a hand-over is not an individual change");
  assert.deepEqual((await row(up2.id)).data.overrides, ["title"]);
  // The series can still be changed as a whole afterwards (batch and coach now agree).
  const result = await edit(w, await row(up1.id), { scope: "SERIES", localTime: "16:00" });
  assert.equal(result.ids.length, 3);
  // The deactivated coach cannot be put back on the series.
  await refusedWith(edit(w, await row(up1.id), { scope: "SERIES", coachId: w.coach.id, batchId: "" }), 422, /active coach/);
});

test("DEC-2: nonexistent and ambiguous local times are refused atomically, naming only the affected dates; nothing is adjusted", async () => {
  const tz = "America/New_York";
  // The conversion itself: both cases throw instead of being moved ("compatible" would have shifted them).
  const gapYear = Temporal.Now.plainDateISO(tz).year + 1;
  const marchStart = Temporal.PlainDate.from({ year: gapYear, month: 3, day: 1 });
  const springForward = marchStart.add({ days: ((7 - marchStart.dayOfWeek) % 7) + 7 }).toString(); // 2nd Sunday of March
  const novemberStart = Temporal.PlainDate.from({ year: gapYear, month: 11, day: 1 });
  const fallBack = novemberStart.add({ days: (7 - novemberStart.dayOfWeek) % 7 }).toString(); // 1st Sunday of November
  assert.throws(() => localInstant(springForward, "02:30", tz), /daylight-saving/);
  assert.throws(() => localInstant(fallBack, "01:30", tz), /daylight-saving/);
  assert.equal(localInstant(fallBack, "00:30", tz), Temporal.PlainDateTime.from(`${fallBack}T00:30`).toZonedDateTime(tz).toInstant().toString());
  // Days around the transitions are ordinary.
  const after = Temporal.PlainDate.from(fallBack).add({ days: 1 }).toString();
  assert.equal(localInstant(after, "01:30", tz), Temporal.PlainDateTime.from(`${after}T01:30`).toZonedDateTime(tz, { disambiguation: "reject" }).toInstant().toString());

  const ny = await world("cs-dec2", tz);
  const weeksBefore = (date: string, weeks: number) => Temporal.PlainDate.from(date).subtract({ weeks }).toString();
  const others = (date: string) => [0, 1, 3].map((w) => Temporal.PlainDate.from(weeksBefore(date, 2)).add({ weeks: w }).toString());
  const atomic = async (work: Promise<unknown>, date: string, name: string) => {
    // The work was started by the caller and may refuse before the snapshot below has finished: attach a handler at once so a fast
    // database cannot report that refusal as an unhandled rejection (assert.rejects still receives the very same rejection).
    work.catch(() => undefined);
    const before = await snapshot(ny);
    await assert.rejects(work, (e: unknown) => {
      assert.ok(e instanceof DomainError, name);
      assert.equal(e.status, 422, `${name}: ${e.message}`);
      assert.match(e.message, new RegExp(date), `${name}: names the date`);
      return true;
    });
    assert.equal(await snapshot(ny), before, `${name}: nothing was written (no rows, no series, no versions)`);
  };
  // Creation of a 4-week series where exactly one date is affected: refused as a whole, naming only that date.
  for (const [date, time, kind] of [[fallBack, "01:30", "ambiguous"], [springForward, "02:30", "nonexistent"]] as const) {
    const name = `create ${kind}`;
    const before = await snapshot(ny);
    await assert.rejects(create(ny, { localDate: weeksBefore(date, 2), localTime: time, repeatWeeks: 4, title: `Night ${kind}` }), (e: unknown) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.status, 422);
      assert.match(e.message, new RegExp(`on ${date} in ${tz}`), name);
      for (const other of others(date)) assert.doesNotMatch(e.message, new RegExp(other), `${name}: valid dates are not reported`);
      return true;
    });
    assert.equal(await snapshot(ny), before, `${name}: no occurrence and no series row`);
  }
  // Existing series around each transition: series / following / single-occurrence changes onto the invalid time.
  for (const [date, time, kind] of [[fallBack, "01:30", "ambiguous"], [springForward, "02:30", "nonexistent"]] as const) {
    const made = await create(ny, { localDate: weeksBefore(date, 2), localTime: "10:00", repeatWeeks: 4, title: `Morning ${kind}` });
    const occurrences = await seriesRows(ny, made.seriesId!);
    assert.deepEqual(occurrences.map((r) => r.data.localTime), ["10:00", "10:00", "10:00", "10:00"]);
    await atomic(edit(ny, occurrences[0], { scope: "SERIES", localTime: time }), date, `series ${kind}`);
    await atomic(edit(ny, occurrences[1], { scope: "FOLLOWING", localTime: time }), date, `following ${kind} (no split series either)`);
    const onTheDay = occurrences.find((r) => r.data.localDate === date)!;
    await atomic(edit(ny, onTheDay, { localTime: time }), "daylight-saving", `this occurrence ${kind}`);
    await atomic(create(ny, { repeatWeeks: 1, localDate: date, localTime: time, title: `One-off ${kind}` }), "daylight-saving", `one-off ${kind}`);
    // A series date shift that lands one occurrence on the transition at that time is refused as well.
    const shiftedOnto = Temporal.PlainDate.from(date).subtract({ days: 1 });
    const made2 = await create(ny, { localDate: weeksBefore(shiftedOnto.toString(), 2), localTime: time, repeatWeeks: 4, title: `Shift ${kind}` });
    const [s1] = await seriesRows(ny, made2.seriesId!);
    await atomic(edit(ny, s1, { scope: "SERIES", localDate: Temporal.PlainDate.from(s1.data.localDate).add({ days: 1 }).toString() }), date, `series shift ${kind}`);
  }
});

test("DEC-3: the server preview lists exactly what a series cancellation cancels and keeps, writes nothing, and binds the cancellation", async () => {
  const w = await world("cs-dec3");
  const made = await create(w, { localDate: day(w, -6), repeatWeeks: 6 });
  const [past, u1, u2, u3, u4, u5] = await seriesRows(w, made.seriesId!);
  const counts = async () =>
    JSON.stringify([
      await snapshot(w),
      (await db().select().from(t.recordRevisions).where(eq(t.recordRevisions.academyId, w.id))).length,
      (await db().select().from(t.audit).where(eq(t.audit.academyId, w.id))).length,
    ]);
  // No individually changed occurrences: every upcoming occurrence is cancelled, the past one never.
  let before = await counts();
  const plain = await preview(w, u1, { scope: "SERIES", reason: "Season over" });
  assert.equal(await counts(), before, "a preview writes nothing (no rows, revisions or audit entries)");
  assert.deepEqual(plain.cancel.map((o) => o.id), [u1.id, u2.id, u3.id, u4.id, u5.id]);
  assert.deepEqual(plain.cancel.map((o) => o.localDate), [u1, u2, u3, u4, u5].map((o) => o.data.localDate));
  assert.equal(plain.cancelCount, 5);
  assert.deepEqual(plain.skipped, []);
  assert.equal(plain.skippedCount, 0);
  assert.ok(!plain.cancel.some((o) => o.id === past.id));
  assert.match(plain.previewToken, /^[0-9a-f]{64}$/);
  assert.equal(plain.seriesVersion, 1);
  // Individually changed occurrences (title; time and duration) stay scheduled unless overwrite is chosen.
  await edit(w, u3, { title: "Final" });
  await edit(w, u4, { localTime: "18:00", duration: 90 });
  const series3 = await preview(w, await row(u1.id), { scope: "SERIES", reason: "Season over" });
  assert.deepEqual(series3.cancel.map((o) => o.id), [u1.id, u2.id, u5.id]);
  assert.equal(series3.cancelCount, 3);
  assert.deepEqual(series3.skipped.map((o) => [o.id, o.localDate, o.fields]), [
    [u3.id, u3.data.localDate, ["title"]],
    [u4.id, u4.data.localDate, ["duration", "localTime"]],
  ]);
  assert.equal(series3.skippedCount, 2);
  assert.equal(series3.skipped[1].localTime, "18:00");
  const following = await preview(w, await row(u2.id), { scope: "FOLLOWING", reason: "Season over" });
  assert.deepEqual(following.cancel.map((o) => o.id), [u2.id, u5.id]);
  assert.deepEqual(following.skipped.map((o) => o.id), [u3.id, u4.id]);
  const overwrite = await preview(w, await row(u2.id), { scope: "FOLLOWING", reason: "Season over", overwriteExceptions: true });
  assert.deepEqual(overwrite.cancel.map((o) => o.id), [u2.id, u3.id, u4.id, u5.id]);
  assert.equal(overwrite.skippedCount, 0);
  assert.equal(new Set([plain.previewToken, series3.previewToken, following.previewToken, overwrite.previewToken]).size, 4, "tokens are specific to state, scope and overwrite");
  // A preview is only for cancelling following / all occurrences.
  await refusedWith(preview(w, await row(u2.id), { scope: "THIS", reason: "x y z" }), 422, /only needed/);
  await refusedWith(previewCalendarCancellation(w.owner, await form(await row(u2.id), { scope: "SERIES" })), 422, /only needed/);
  await refusedWith(preview(w, await row(u2.id), { scope: "SERIES", title: "Renamed too" }), 422, /without changing/);
  // The token binds the scope and the overwrite choice: another request with it is refused, nothing written.
  before = await counts();
  await refusedWith(edit(w, await row(u2.id), { scope: "SERIES", cancel: true, reason: "Season over", previewToken: following.previewToken }), 409, /changed after the cancellation was previewed/);
  await refusedWith(edit(w, await row(u2.id), { scope: "FOLLOWING", cancel: true, reason: "Season over", previewToken: overwrite.previewToken }), 409, /changed after/);
  await refusedWith(edit(w, await row(u2.id), { scope: "FOLLOWING", cancel: true, reason: "Season over", previewToken: "0".repeat(64) }), 409, /changed after/);
  assert.equal(await counts(), before);
  // The matching cancellation cancels exactly the previewed set and records it.
  const done = await edit(w, await row(u2.id), { scope: "FOLLOWING", cancel: true, reason: "Season over", previewToken: following.previewToken });
  assert.deepEqual(done.ids.sort(), following.cancel.map((o) => o.id).sort());
  assert.deepEqual(done.skipped, following.skipped.map((o) => o.id));
  assert.deepEqual(done.skippedDates, following.skipped.map((o) => o.localDate));
  for (const o of following.cancel) assert.equal((await row(o.id)).status, "CANCELLED");
  for (const o of [past, u1, u3, u4]) assert.equal((await row(o.id)).status, "SCHEDULED");
  const [audit] = await db().select().from(t.audit).where(and(eq(t.audit.entityId, made.seriesId!), eq(t.audit.action, "calendar-series-cancel")));
  const detail = audit.detail as { previewToken: string; skipped: string[]; skippedDates: string[]; changed: string[] };
  assert.equal(detail.previewToken, following.previewToken);
  assert.deepEqual(detail.skippedDates, [u3.data.localDate, u4.data.localDate]);
});

test("DEC-3: a stale preview is refused with a conflict and nothing is cancelled; a fresh preview succeeds", async () => {
  const w = await world("cs-dec3-stale");
  const made = await create(w, { repeatWeeks: 5 });
  const [o1, o2, o3, o4, o5] = await seriesRows(w, made.seriesId!);
  const confirm = (target: Row, p: Preview, changes: Changes = {}) =>
    edit(w, target, { scope: p.scope, cancel: true, reason: "Hall closed", overwriteExceptions: p.overwriteExceptions, previewToken: p.previewToken, ...changes });
  const staleRefused = async (work: Promise<unknown>, name: string) => {
    const before = await snapshot(w);
    await assert.rejects(work, (e: unknown) => {
      assert.ok(e instanceof DomainError, name);
      assert.equal(e.status, 409, `${name}: ${e.message}`);
      return true;
    });
    assert.equal(await snapshot(w), before, `${name}: nothing cancelled`);
  };
  // 1. A single-occurrence edit after the preview (it does not change the series version).
  let p = await preview(w, o1, { scope: "SERIES", reason: "Hall closed" });
  await edit(w, o3, { title: "Exhibition" });
  assert.equal((await series(made.seriesId!)).version, 1, "the series version did not change");
  await staleRefused(confirm(await row(o1.id), p), "single-occurrence edit after preview");
  p = await preview(w, await row(o1.id), { scope: "SERIES", reason: "Hall closed" });
  assert.deepEqual(p.skipped.map((o) => o.id), [o3.id], "the fresh preview shows the new exception");
  // 2. A series edit after the preview (series version changes; the client re-reads it, the token is still stale).
  await edit(w, await row(o2.id), { scope: "SERIES", duration: 45 });
  await staleRefused(confirm(await row(o1.id), p), "series edit after preview");
  await staleRefused(confirm(await row(o1.id), p, { seriesVersion: p.seriesVersion }), "series edit after preview, old series version");
  // 3. An individual cancellation (or restore) after the preview moves an occurrence out of (or into) the sets.
  p = await preview(w, await row(o1.id), { scope: "SERIES", reason: "Hall closed" });
  await edit(w, await row(o5.id), { cancel: true, reason: "Tournament" });
  await staleRefused(confirm(await row(o1.id), p), "individual cancellation after preview");
  p = await preview(w, await row(o1.id), { scope: "SERIES", reason: "Hall closed" });
  await edit(w, await row(o5.id), { cancel: false });
  await staleRefused(confirm(await row(o1.id), p), "restore after preview");
  // 4. An occurrence that starts between preview and confirmation leaves the set (simulated by moving its instant).
  p = await preview(w, await row(o1.id), { scope: "SERIES", reason: "Hall closed" });
  const o4now = await row(o4.id);
  await db().update(t.calendarEvents).set({ data: { ...o4now.data, startsAt: new Date(Date.now() - 60_000).toISOString() } }).where(eq(t.calendarEvents.id, o4.id));
  await staleRefused(confirm(await row(o1.id), p), "occurrence started after preview");
  await db().update(t.calendarEvents).set({ data: o4now.data }).where(eq(t.calendarEvents.id, o4.id));
  // 5. A fresh preview succeeds and cancels exactly what it showed.
  p = await preview(w, await row(o1.id), { scope: "SERIES", reason: "Hall closed" });
  const done = await confirm(await row(o1.id), p);
  assert.deepEqual(done.ids.sort(), p.cancel.map((o) => o.id).sort());
  assert.deepEqual(done.skipped, p.skipped.map((o) => o.id));
  for (const o of p.cancel) assert.equal((await row(o.id)).status, "CANCELLED");
  for (const o of p.skipped) assert.equal((await row(o.id)).status, "SCHEDULED");
});

test("DEC-3: concurrent cancellations, idempotent retries, academy isolation and authorization", async () => {
  const w = await world("cs-dec3-race");
  const made = await create(w, { repeatWeeks: 5 });
  const [o1, o2, o3] = await seriesRows(w, made.seriesId!);
  await edit(w, o2, { title: "Exception" });
  const settle = (p: Promise<unknown>) => p.then((r) => r as { replayed?: boolean }, (e: DomainError) => e.status);
  // Two different cancellations previewed from the same state and confirmed at once: exactly one is applied.
  const all = await preview(w, await row(o1.id), { scope: "SERIES", reason: "Season over" });
  const tail = await preview(w, await row(o3.id), { scope: "FOLLOWING", reason: "Coach away" });
  const outcomes = await Promise.all([
    settle(edit(w, await row(o1.id), { scope: "SERIES", cancel: true, reason: "Season over", previewToken: all.previewToken })),
    settle(edit(w, await row(o3.id), { scope: "FOLLOWING", cancel: true, reason: "Coach away", previewToken: tail.previewToken }, w.admin)),
  ]);
  assert.equal(outcomes.filter((o) => o === 409).length, 1, JSON.stringify(outcomes));
  const winner = outcomes[0] === 409 ? tail : all;
  const statuses = await seriesRows(w, made.seriesId!);
  assert.deepEqual(
    statuses.filter((r) => r.status === "CANCELLED").map((r) => r.id).sort(),
    winner.cancel.map((o) => o.id).sort(),
    "the cancelled set is exactly one previewed set, never a mix",
  );
  // Retrying the applied cancellation (lost response): the recorded result is returned, nothing is applied twice.
  const retryBody = winner === all
    ? { target: o1, scope: "SERIES", reason: "Season over", by: w.owner }
    : { target: o3, scope: "FOLLOWING", reason: "Coach away", by: w.admin };
  const firstForm = await form(retryBody.target, { scope: retryBody.scope, cancel: true, reason: retryBody.reason, previewToken: winner.previewToken });
  const versionsBefore = await snapshot(w);
  const replays = await Promise.all([saveCalendarEvent(retryBody.by, firstForm), saveCalendarEvent(retryBody.by, firstForm)]);
  for (const r of replays as { replayed?: boolean; ids: string[] }[]) {
    assert.equal(r.replayed, true);
    assert.deepEqual(r.ids.sort(), winner.cancel.map((o) => o.id).sort());
  }
  assert.equal(await snapshot(w), versionsBefore, "a retry changes nothing");
  // The same token with a different request is not a retry.
  await refusedWith(saveCalendarEvent(retryBody.by, { ...firstForm, reason: "Another reason" }), 409, /already used/);
  await refusedWith(saveCalendarEvent(retryBody.by, { ...firstForm, overwriteExceptions: true }), 409, /already used/);
  // Another academy can neither preview nor cancel (nor replay) this series.
  const other = await world("cs-dec3-other");
  const fresh = await create(w, { localDate: day(w, 60), repeatWeeks: 3, title: "Fresh series" });
  const [f1] = await seriesRows(w, fresh.seriesId!);
  const freshPreview = await preview(w, f1, { scope: "SERIES", reason: "Rain" });
  const before = await snapshot(w);
  await refusedWith(preview(w, f1, { scope: "SERIES", reason: "Rain" }, other.owner), 404);
  await refusedWith(edit(w, f1, { scope: "SERIES", cancel: true, reason: "Rain", previewToken: freshPreview.previewToken }, other.owner), 404);
  await refusedWith(saveCalendarEvent(other.owner, firstForm), 404);
  // Roles that cannot change events can neither preview nor cancel.
  for (const by of [w.coach, w.finance, w.nutrition, w.guardian, w.adult]) {
    await refusedWith(preview(w, f1, { scope: "SERIES", reason: "Rain" }, by), 403);
    await refusedWith(edit(w, f1, { scope: "SERIES", cancel: true, reason: "Rain", previewToken: freshPreview.previewToken }, by), 403);
  }
  assert.equal(await snapshot(w), before);
  // Admin and head coach can.
  for (const by of [w.admin, w.head]) assert.equal((await preview(w, f1, { scope: "SERIES", reason: "Rain" }, by)).cancelCount, 3);
  await edit(w, f1, { scope: "SERIES", cancel: true, reason: "Rain", previewToken: freshPreview.previewToken }, w.head);
  assert.ok((await seriesRows(w, fresh.seriesId!)).every((r) => r.status === "CANCELLED"));
});
