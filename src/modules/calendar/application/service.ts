import { createHash } from "node:crypto";
import { z } from "zod";
import { and, asc, eq, sql } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import * as t from "../../../infrastructure/database/schema";
import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import type { CalendarData, CalendarField } from "../../academy/domain/types";
import { DomainError, validatePublish } from "../../training/domain/rules";
import {
  unit,
  coachingRoles,
  scopedBatch,
  requirePlayer,
  expectVersion,
  history,
  type Tx,
} from "../../academy/application/access";
import {
  scheduleInstant,
  ensureSlot,
  reservedSlots,
  clashing,
  type Slot,
} from "./scheduling";
import { requireActiveCoach } from "../../settings/application/coach-assignments";
const eventSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().optional(),
  kind: z.enum(["TRIAL", "EVENT", "CLOSURE"]),
  title: z.string().trim().min(2).max(150),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date."),
  localTime: z.string(),
  duration: z.number().int().min(1).max(1440),
  branchId: z.string(),
  coachId: z.string(),
  batchId: z.string(),
  playerIds: z.array(z.string()).max(200),
  enquiryId: z.string().nullable(),
  repeatWeeks: z.number().int().min(1).max(12).default(1),
  cancel: z.boolean().default(false),
  // Stage 5E. Which occurrences a change to an existing event applies to: only this one, this one and the
  // later ones of its series, or every occurrence of its series that has not started.
  scope: z.enum(["THIS", "FOLLOWING", "SERIES"]).default("THIS"),
  // The series version the change was prepared against (required for FOLLOWING and SERIES).
  seriesVersion: z.number().int().optional(),
  // Series changes leave individually changed occurrences alone unless this is set.
  overwriteExceptions: z.boolean().default(false),
  // Mandatory when the request cancels at least one occurrence.
  reason: z.string().trim().max(500).default(""),
  // Optional idempotency key for creation: a retried request returns what the first one created.
  requestId: z.string().uuid().optional(),
  // DEC-3: the token of the server preview this cancellation was confirmed against (required for cancelling the
  // following or all occurrences of a series; the server recomputes it under the cancellation's locks).
  previewToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
type EventInput = z.infer<typeof eventSchema>;
type EventRow = typeof t.calendarEvents.$inferSelect;
type SeriesRow = typeof t.calendarSeries.$inferSelect;
type Values = Pick<
  CalendarData,
  "title" | "localDate" | "localTime" | "duration" | "branchId" | "coachId" | "batchId" | "playerIds"
>;
const FIELDS = [
  "title",
  "localDate",
  "localTime",
  "duration",
  "branchId",
  "coachId",
  "batchId",
  "playerIds",
] as const satisfies readonly CalendarField[];
const TIME_FIELDS: CalendarField[] = ["localDate", "localTime", "duration"];
const sameValue = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    : a === b;
const started = (e: EventRow, now: number) => Date.parse(e.data.startsAt) <= now;
const listDates = (dates: string[]) => [...new Set(dates)].sort().join(", ");
const slotOf = (e: { id: string; kind: string; data: CalendarData }): Slot => ({
  id: e.id,
  startsAt: e.data.startsAt,
  duration: e.data.duration,
  branchId: e.data.branchId,
  coachId: e.data.coachId,
  playerIds: e.data.playerIds,
  closure: e.kind === "CLOSURE",
});
/** Sets overrides on data, keeping the key absent when there are none (unchanged payload shape). */
function withOverrides(data: CalendarData, overrides: Set<CalendarField>) {
  const next = { ...data };
  if (overrides.size) next.overrides = [...overrides].sort();
  else delete next.overrides;
  return next;
}
/** Recomputes the instants of an occurrence whose date, time or length changed, in the academy's timezone. */
function retime(data: CalendarData, timezone: string): CalendarData {
  return {
    ...data,
    ...scheduleInstant(data.localDate, data.localTime, data.duration, timezone),
    timezone,
  };
}
/** Validates the values in the form (branch, coach, batch, players, enquiry); returns the participants. */
async function validateValues(a: Actor, tx: Tx, v: EventInput) {
  const [branch] = await tx
    .select()
    .from(t.branches)
    .where(
      and(eq(t.branches.academyId, a.academyId), eq(t.branches.id, v.branchId)),
    );
  if (!branch) throw new DomainError("Branch not found.", 404);
  if (v.kind !== "CLOSURE") {
    const [coach] = await tx
      .select()
      .from(t.memberships)
      .where(
        and(
          eq(t.memberships.academyId, a.academyId),
          eq(t.memberships.userId, v.coachId),
          eq(t.memberships.active, true),
        ),
      );
    if (!coach || !coachingRoles.includes(coach.role))
      throw new DomainError("Choose an active coach.");
  }
  let participatingPlayers=[...v.playerIds];
  if (v.batchId && v.kind!=='CLOSURE') {
    const batch=await scopedBatch(a,v.batchId,tx);
    if(batch.branchId!==v.branchId||batch.coachId!==v.coachId)throw new DomainError('Batch events must use the assigned branch and coach.');
    const batchPlayers=await tx.select().from(t.players).where(and(eq(t.players.academyId,a.academyId),eq(t.players.batchId,v.batchId)));
    const profiles=await tx.select().from(t.profiles).where(eq(t.profiles.academyId,a.academyId));
    participatingPlayers=[...participatingPlayers,...batchPlayers.filter(player=>!profiles.some(profile=>profile.playerId===player.id&&profile.data.status!=='ACTIVE')).map(player=>player.id)];
  }
  for (const id of v.playerIds) await requirePlayer(a, id, tx);
  if (v.enquiryId) {
    const [e] = await tx
      .select()
      .from(t.enquiries)
      .where(
        and(
          eq(t.enquiries.academyId, a.academyId),
          eq(t.enquiries.id, v.enquiryId),
        ),
      );
    if (!e) throw new DomainError("Enquiry not found.", 404);
  }
  const values: Values = {
    title: v.title,
    localDate: v.localDate,
    localTime: v.localTime,
    duration: v.duration,
    branchId: v.branchId,
    coachId: v.kind === "CLOSURE" ? "" : v.coachId,
    batchId: v.batchId,
    playerIds: v.kind === "CLOSURE" ? [] : [...new Set(participatingPlayers)],
  };
  return values;
}
/**
 * DEC-1 (owner decision, option B): a one-off event that has started or ended can still be corrected and cancelled,
 * but it keeps the coach, branch and batch it was held with (Stage 5D historical attribution). Those three are
 * compared with the stored values instead of being re-checked against today's memberships and batches (the coach
 * may have been deactivated and the batch handed over since), and the participants are not re-derived from today's
 * batch roster. Players added by the correction must be players of the academy.
 */
async function validateStartedOneOff(a: Actor, tx: Tx, v: EventInput, row: EventRow) {
  const coachId = v.kind === "CLOSURE" ? "" : v.coachId;
  if (v.branchId !== row.data.branchId || coachId !== row.data.coachId || v.batchId !== row.data.batchId)
    throw new DomainError(
      "This event has already started. It keeps the coach, branch and batch it was held with; only its other details can be corrected.",
      422,
    );
  const playerIds = v.kind === "CLOSURE" ? [] : [...new Set(v.playerIds)];
  const stored = new Set(row.data.playerIds);
  for (const id of playerIds) if (!stored.has(id)) await requirePlayer(a, id, tx);
  const values: Values = {
    title: v.title,
    localDate: v.localDate,
    localTime: v.localTime,
    duration: v.duration,
    branchId: row.data.branchId,
    coachId: row.data.coachId,
    batchId: row.data.batchId,
    playerIds,
  };
  return values;
}
/**
 * Every occurrence written by a multi-occurrence change must still have an active coach and, when it belongs
 * to a batch, that batch's branch and coach (the same rules the form is checked against).
 */
async function checkOccurrences(a: Actor, tx: Tx, kind: string, rows: CalendarData[]) {
  if (kind === "CLOSURE" || !rows.length) return;
  const [members, batches] = await Promise.all([
    tx.select().from(t.memberships).where(eq(t.memberships.academyId, a.academyId)),
    tx.select().from(t.batches).where(eq(t.batches.academyId, a.academyId)),
  ]);
  const bad = rows.filter((data) => {
    const coach = members.find((m) => m.userId === data.coachId);
    if (!coach || !coach.active || !coachingRoles.includes(coach.role)) return true;
    if (!data.batchId) return false;
    const batch = batches.find((b) => b.id === data.batchId);
    return !batch || batch.branchId !== data.branchId || batch.coachId !== data.coachId;
  });
  if (bad.length)
    throw new DomainError(
      `The occurrences on ${listDates(bad.map((d) => d.localDate))} would not have an active coach that matches their batch and branch. Nothing was changed.`,
    );
}
/** All-or-nothing conflict check for occurrences written together. */
async function ensureSlots(tx: Tx, a: Actor, rows: { id: string; kind: string; data: CalendarData }[]) {
  if (!rows.length) return;
  const clashes = clashing(rows.map(slotOf), await reservedSlots(tx, a));
  if (!clashes.length) return;
  if (rows.length === 1)
    throw new DomainError(
      "This time conflicts with a coach, player or branch closure. Parallel sessions need distinct coaches and players.",
      409,
    );
  const dates = rows.filter((r) => clashes.some((c) => c.id === r.id)).map((r) => r.data.localDate);
  throw new DomainError(
    `${dates.length} occurrence${dates.length === 1 ? "" : "s"} (${listDates(dates)}) conflicts with a coach, player or branch closure. Nothing was saved.`,
    409,
  );
}
function requireReason(v: EventInput) {
  if (v.reason.length < 3)
    throw new DomainError("Give a reason for the cancellation (at least 3 characters).", 422);
}
/** Writes one occurrence, guarded by its version, and records the revision. */
async function writeOccurrence(
  tx: Tx,
  a: Actor,
  row: EventRow,
  data: CalendarData,
  status: string,
) {
  const version = row.version + 1;
  const [saved] = await tx
    .update(t.calendarEvents)
    .set({ data, status, version, seriesId: data.seriesId })
    .where(
      and(
        eq(t.calendarEvents.academyId, a.academyId),
        eq(t.calendarEvents.id, row.id),
        eq(t.calendarEvents.version, row.version),
      ),
    )
    .returning({ id: t.calendarEvents.id });
  if (!saved)
    throw new DomainError(
      "This record changed. Reload the saved record before continuing; your input is preserved.",
      409,
    );
  await history(tx, a, "calendar-event", row.id, version, { data, status });
  return row.id;
}
async function createEvents(a: Actor, tx: Tx, v: EventInput, values: Values) {
  if (v.cancel) throw new DomainError("A new event cannot be created as cancelled.", 422);
  if (v.scope !== "THIS")
    throw new DomainError("Choose which occurrences to change only when editing an event.", 422);
  const recurring = v.repeatWeeks > 1;
  if (v.requestId) {
    // A retry of a request that already succeeded returns what it created, never a second copy.
    if (recurring) {
      const [series] = await tx
        .select()
        .from(t.calendarSeries)
        .where(eq(t.calendarSeries.id, v.requestId));
      if (series) {
        if (
          series.academyId !== a.academyId ||
          series.kind !== v.kind ||
          series.data.firstDate !== v.localDate ||
          series.data.count !== v.repeatWeeks
        )
          throw new DomainError("This request was already used for a different event. Reload and try again.", 409);
        const rows = await tx
          .select({ id: t.calendarEvents.id })
          .from(t.calendarEvents)
          .where(and(eq(t.calendarEvents.academyId, a.academyId), eq(t.calendarEvents.seriesId, series.id)))
          .orderBy(asc(t.calendarEvents.occurrenceDate));
        return { id: rows[0]?.id, ids: rows.map((r) => r.id), seriesId: series.id, replayed: true };
      }
    } else {
      const [existing] = await tx
        .select()
        .from(t.calendarEvents)
        .where(eq(t.calendarEvents.id, v.requestId));
      if (existing) {
        if (existing.academyId !== a.academyId || existing.kind !== v.kind || existing.seriesId)
          throw new DomainError("This request was already used for a different event. Reload and try again.", 409);
        return { id: existing.id, ids: [existing.id], seriesId: null, replayed: true };
      }
    }
  }
  const seriesId = recurring ? (v.requestId ?? crypto.randomUUID()) : null;
  const first = Temporal.PlainDate.from(v.localDate);
  const rows: { id: string; kind: string; date: string; data: CalendarData }[] = [];
  const invalid: string[] = [];
  for (let week = 0; week < v.repeatWeeks; week++) {
    const localDate = first.add({ weeks: week }).toString();
    try {
      rows.push({
        id: !recurring && v.requestId ? v.requestId : crypto.randomUUID(),
        kind: v.kind,
        date: localDate,
        data: retime(
          { ...values, localDate, enquiryId: v.enquiryId, seriesId } as CalendarData,
          a.timezone,
        ),
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      invalid.push(localDate);
    }
  }
  if (invalid.length)
    throw new DomainError(
      recurring
        ? `${v.localTime} does not exist or occurs twice on ${listDates(invalid)} in ${a.timezone} (daylight saving). Choose another time or start date; nothing was saved.`
        : "Choose a valid local date and time. Ambiguous or missing daylight-saving times must be changed explicitly.",
    );
  await ensureSlots(tx, a, rows);
  if (seriesId) {
    await tx.insert(t.calendarSeries).values({
      id: seriesId,
      academyId: a.academyId,
      kind: v.kind,
      data: {
        origin: "CREATED",
        firstDate: v.localDate,
        count: v.repeatWeeks,
        interval: 1,
        localTime: v.localTime,
        duration: v.duration,
        timezone: a.timezone,
      },
    });
    await history(tx, a, "calendar-series", seriesId, 1, { kind: v.kind, count: v.repeatWeeks });
  }
  for (const row of rows) {
    await tx.insert(t.calendarEvents).values({
      id: row.id,
      academyId: a.academyId,
      kind: v.kind,
      data: row.data,
      seriesId,
      occurrenceDate: seriesId ? row.date : null,
    });
    await history(tx, a, "calendar-event", row.id, 1, { data: row.data, status: "SCHEDULED" });
  }
  return { id: rows[0].id, ids: rows.map((r) => r.id), seriesId };
}
/** "This occurrence": patch only the changed fields; a series occurrence stays in its series as an exception. */
async function editOccurrence(a: Actor, tx: Tx, v: EventInput, row: EventRow, values: Values) {
  const changed = FIELDS.filter((f) => !sameValue(row.data[f], values[f]));
  const overrides = new Set(row.data.overrides ?? []);
  let data: CalendarData = { ...row.data };
  for (const f of changed) {
    (data as Record<string, unknown>)[f] = values[f];
    if (row.seriesId) overrides.add(f);
  }
  if (changed.some((f) => TIME_FIELDS.includes(f))) data = retime(data, a.timezone);
  let status = row.status;
  if (v.cancel && row.status !== "CANCELLED") {
    requireReason(v);
    status = "CANCELLED";
    data.cancellation = { reason: v.reason, at: new Date().toISOString(), scope: "THIS" };
    if (row.seriesId) overrides.add("status");
  } else if (!v.cancel && row.status === "CANCELLED") {
    status = "SCHEDULED";
    // Restoring an occurrence the series cancelled makes it differ from the series; restoring one that was
    // cancelled on its own makes it agree with the series again.
    if (row.seriesId) {
      if (row.data.cancellation && row.data.cancellation.scope !== "THIS") overrides.add("status");
      else overrides.delete("status");
    }
    delete data.cancellation;
  }
  if (row.seriesId) data = withOverrides(data, overrides);
  if (!changed.length && status === row.status)
    return { id: row.id, ids: [] as string[], seriesId: row.seriesId, skipped: [] as string[] };
  if (status === "SCHEDULED")
    await ensureSlot(tx, a, slotOf({ id: row.id, kind: row.kind, data }));
  await writeOccurrence(tx, a, row, data, status);
  return { id: row.id, ids: [row.id], seriesId: row.seriesId, skipped: [] as string[] };
}
/**
 * "This and following" / "Entire series". Only occurrences that have not started are changed; past ones are
 * history. Occurrences changed individually keep their own values (and stay scheduled on a cancellation)
 * unless overwriteExceptions is set. All-or-nothing: one transaction, one conflict check for the whole set.
 */
/**
 * Locks the series row and all of its occurrences (in occurrence order, so concurrent series operations always lock
 * in the same order) and checks the series version the client prepared the change against. Every series
 * operation, and the DEC-3 cancellation preview, runs inside unit(), which already holds the academy row lock.
 */
async function lockSeries(a: Actor, tx: Tx, v: EventInput, row: EventRow) {
  const [series] = await tx
    .select()
    .from(t.calendarSeries)
    .where(and(eq(t.calendarSeries.academyId, a.academyId), eq(t.calendarSeries.id, row.seriesId!)))
    .for("update");
  if (!series) throw new DomainError("Series not found.", 404);
  if (v.seriesVersion === undefined)
    throw new DomainError("Reload the calendar before changing the series.", 409);
  expectVersion(series.version, v.seriesVersion);
  const members = await tx
    .select()
    .from(t.calendarEvents)
    .where(and(eq(t.calendarEvents.academyId, a.academyId), eq(t.calendarEvents.seriesId, series.id)))
    .orderBy(asc(t.calendarEvents.occurrenceDate))
    .for("update");
  return { series, members };
}
/**
 * DEC-3: what cancelling the following / all occurrences would do. Computed by the server, under the same locks,
 * for the preview and again for the cancellation itself. `cancel` are the scheduled, not-yet-started occurrences in
 * scope that will be cancelled; `skipped` are the individually changed ones that stay scheduled (none when
 * overwrite is chosen). The token fingerprints everything that decides the two sets: the academy, the series and
 * its version, the opened occurrence and its version, the scope, the overwrite choice, and the id and version of
 * every occurrence in either set. A single-occurrence change bumps that occurrence's version (not the series
 * version), an occurrence that starts in the meantime leaves the sets, and a restore or another cancellation moves
 * an occurrence in or out of them, so each of those changes the token.
 */
function cancellationPlan(a: Actor, v: EventInput, row: EventRow, series: SeriesRow, members: EventRow[], now: number) {
  const from = row.occurrenceDate!;
  const cancel: EventRow[] = [];
  const skipped: EventRow[] = [];
  for (const m of members) {
    if (started(m, now) || (v.scope !== "SERIES" && m.occurrenceDate! < from) || m.status !== "SCHEDULED") continue;
    if (m.data.overrides?.length && !v.overwriteExceptions) skipped.push(m);
    else cancel.push(m);
  }
  const token = createHash("sha256")
    .update(
      JSON.stringify({
        purpose: "calendar-series-cancellation",
        academyId: a.academyId,
        seriesId: series.id,
        seriesVersion: series.version,
        occurrence: [row.id, row.version],
        scope: v.scope,
        overwriteExceptions: v.overwriteExceptions,
        cancel: cancel.map((m) => [m.id, m.version]),
        skipped: skipped.map((m) => [m.id, m.version]),
      }),
    )
    .digest("hex");
  return { cancel, skipped, token };
}
const occurrenceOf = (m: EventRow) => ({
  id: m.id,
  localDate: m.data.localDate,
  localTime: m.data.localTime,
  occurrenceDate: m.occurrenceDate,
});
async function editSeries(a: Actor, tx: Tx, v: EventInput, row: EventRow, values: Values, now: number) {
  const { series, members } = await lockSeries(a, tx, v, row);
  const from = row.occurrenceDate!;
  const targets = members.filter(
    (m) => !started(m, now) && (v.scope === "SERIES" || m.occurrenceDate! >= from),
  );
  const changed = FIELDS.filter((f) => !sameValue(row.data[f], values[f]));
  const writes = new Map<string, { row: EventRow; data: CalendarData; status: string }>();
  const skipped: string[] = [];
  const skippedDates: string[] = [];
  let action: "cancel" | "change";
  if (v.cancel) {
    action = "cancel";
    if (changed.some((f) => f !== "playerIds"))
      throw new DomainError("Cancel the occurrences without changing other fields, or save the changes first.", 422);
    requireReason(v);
    // DEC-3: the cancellation must match a server preview of exactly this state; it is recomputed here, under the
    // academy, series and occurrence locks held until commit, so nothing can change between check and write.
    const plan = cancellationPlan(a, v, row, series, members, now);
    if (!v.previewToken)
      throw new DomainError(
        "Review which occurrences will be cancelled and which stay scheduled before confirming the cancellation.",
        422,
      );
    if (v.previewToken !== plan.token)
      throw new DomainError(
        "The occurrences of this series changed after the cancellation was previewed. Nothing was cancelled; review the cancellation again.",
        409,
      );
    const at = new Date().toISOString();
    skipped.push(...plan.skipped.map((m) => m.id));
    skippedDates.push(...plan.skipped.map((m) => m.data.localDate));
    for (const m of plan.cancel) {
      writes.set(m.id, {
        row: m,
        data: { ...m.data, cancellation: { reason: v.reason, at, scope: v.scope } },
        status: "CANCELLED",
      });
    }
  } else {
    action = "change";
    if (row.status === "CANCELLED")
      throw new DomainError("This occurrence is cancelled. Restore it with “This occurrence” before changing the series.", 422);
    const shift = changed.includes("localDate")
      ? Temporal.PlainDate.from(row.data.localDate).until(Temporal.PlainDate.from(values.localDate)).days
      : 0;
    const invalid: string[] = [];
    for (const m of targets) {
      if (m.status !== "SCHEDULED") continue;
      const overrides = new Set(m.data.overrides ?? []);
      let data: CalendarData = { ...m.data };
      let kept = false;
      for (const f of changed) {
        if (overrides.has(f) && !v.overwriteExceptions) {
          kept = true;
          continue;
        }
        (data as Record<string, unknown>)[f] =
          f === "localDate"
            ? Temporal.PlainDate.from(m.data.localDate).add({ days: shift }).toString()
            : values[f];
        overrides.delete(f);
      }
      if (kept) {
        skipped.push(m.id);
        skippedDates.push(m.data.localDate);
      }
      data = withOverrides(data, overrides);
      if (TIME_FIELDS.some((f) => !sameValue(data[f as keyof CalendarData], m.data[f as keyof CalendarData]))) {
        try {
          data = retime(data, a.timezone);
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          invalid.push(data.localDate);
          continue;
        }
      }
      if (JSON.stringify(data) !== JSON.stringify(m.data))
        writes.set(m.id, { row: m, data, status: m.status });
    }
    if (invalid.length)
      throw new DomainError(
        `${values.localTime} does not exist or occurs twice on ${listDates(invalid)} in ${a.timezone} (daylight saving). Nothing was changed.`,
      );
    const moved = [...writes.values()];
    await checkOccurrences(a, tx, row.kind, moved.map((w) => w.data));
    await ensureSlots(tx, a, moved.map((w) => ({ id: w.row.id, kind: w.row.kind, data: w.data })));
  }
  // "This and following" changes split the series when earlier occurrences remain in it: the later part
  // becomes a new series (split from this one), so later "entire series" changes of either part stay apart.
  let splitInto: string | null = null;
  const tail = members.filter((m) => !started(m, now) && m.occurrenceDate! >= from);
  if (action === "change" && v.scope === "FOLLOWING" && writes.size && tail.length < members.length) {
    splitInto = crypto.randomUUID();
    await tx.insert(t.calendarSeries).values({
      id: splitInto,
      academyId: a.academyId,
      kind: series.kind,
      splitFrom: series.id,
      data: {
        origin: "SPLIT",
        firstDate: from,
        count: tail.length,
        interval: 1,
        localTime: values.localTime,
        duration: values.duration,
        timezone: a.timezone,
        splitAt: from,
      },
    });
    await history(tx, a, "calendar-series", splitInto, 1, { kind: series.kind, splitFrom: series.id, splitAt: from });
    for (const m of tail) {
      const w = writes.get(m.id) ?? { row: m, data: m.data, status: m.status };
      writes.set(m.id, { ...w, data: { ...w.data, seriesId: splitInto } });
    }
  }
  const ids: string[] = [];
  for (const w of writes.values()) ids.push(await writeOccurrence(tx, a, w.row, w.data, w.status));
  const seriesVersion = series.version + 1;
  if (ids.length) {
    const [bumped] = await tx
      .update(t.calendarSeries)
      .set({ version: seriesVersion })
      .where(
        and(
          eq(t.calendarSeries.academyId, a.academyId),
          eq(t.calendarSeries.id, series.id),
          eq(t.calendarSeries.version, series.version),
        ),
      )
      .returning({ id: t.calendarSeries.id });
    if (!bumped) throw new DomainError("This series changed. Reload the calendar and try again.", 409);
    await history(tx, a, "calendar-series", series.id, seriesVersion, {
      scope: v.scope,
      action,
      from,
      splitInto,
    });
    await tx.insert(t.audit).values({
      id: crypto.randomUUID(),
      academyId: a.academyId,
      actorId: a.id,
      entityId: series.id,
      version: seriesVersion,
      action: `calendar-series-${action}`,
      detail: {
        scope: v.scope,
        from,
        fields: action === "change" ? changed : [],
        overwriteExceptions: v.overwriteExceptions,
        ...(action === "cancel" ? { reason: v.reason, previewToken: v.previewToken, occurrenceId: row.id } : {}),
        changed: ids,
        skipped,
        skippedDates,
        splitInto,
      },
    });
  }
  return {
    id: row.id,
    ids,
    seriesId: splitInto ?? series.id,
    skipped,
    skippedDates,
  };
}
/**
 * DEC-3 idempotency: a cancellation retried with the token it was confirmed with (e.g. after a lost response)
 * returns the recorded result instead of a version conflict. Only this academy's cancellation of this occurrence
 * with this exact token counts; tokens include the series version, which the first cancellation raised, so a
 * fresh preview never reproduces an old token.
 */
async function replayedCancellation(a: Actor, tx: Tx, v: EventInput) {
  if (!v.id || !v.cancel || v.scope === "THIS" || !v.previewToken) return null;
  const [done] = await tx
    .select()
    .from(t.audit)
    .where(
      and(
        eq(t.audit.academyId, a.academyId),
        eq(t.audit.action, "calendar-series-cancel"),
        sql`${t.audit.detail}->>'previewToken' = ${v.previewToken}`,
        sql`${t.audit.detail}->>'occurrenceId' = ${v.id}`,
      ),
    );
  if (!done) return null;
  const detail = done.detail as {
    scope: string;
    overwriteExceptions: boolean;
    reason: string;
    changed: string[];
    skipped: string[];
    skippedDates?: string[];
  };
  // The token was used: only an identical request is a retry; anything else is refused, never applied.
  if (detail.scope !== v.scope || detail.overwriteExceptions !== v.overwriteExceptions || detail.reason !== v.reason)
    throw new DomainError(
      "This preview was already used for a different cancellation. Review the cancellation again.",
      409,
    );
  return {
    id: v.id,
    ids: detail.changed,
    seriesId: done.entityId,
    skipped: detail.skipped,
    skippedDates: detail.skippedDates ?? [],
    replayed: true,
  };
}
/**
 * Loads an existing event for a change (row locked), checks its version and kind, applies the started-event rule
 * and validates the submitted values. Shared by saves and the DEC-3 preview so both refuse the same requests.
 */
async function loadForEdit(a: Actor, tx: Tx, v: EventInput) {
  if (v.repeatWeeks !== 1)
    throw new DomainError(
      "Edit a single occurrence, or create a new recurring series.",
    );
  const [row] = await tx
    .select()
    .from(t.calendarEvents)
    .where(
      and(
        eq(t.calendarEvents.academyId, a.academyId),
        eq(t.calendarEvents.id, v.id!),
      ),
    )
    .for("update");
  if (!row) throw new DomainError("Calendar event not found.", 404);
  expectVersion(row.version, v.version ?? 0);
  if (row.kind !== v.kind)
    throw new DomainError("Event kind cannot be changed.");
  const now = Date.now();
  const hasStarted = started(row, now);
  // DEC-1: occurrences of a recurring series that have started or ended are history, in every scope.
  if (hasStarted && row.seriesId)
    throw new DomainError(
      "This occurrence has already started or ended. Past occurrences of a recurring series are kept as they were and cannot be changed or cancelled.",
      409,
    );
  // DEC-1: a started one-off event can be corrected or cancelled, but keeps its coach, branch and batch.
  const values = hasStarted ? await validateStartedOneOff(a, tx, v, row) : await validateValues(a, tx, v);
  return { row, values, now };
}
export async function saveEventTx(a: Actor, tx: Tx, input: unknown) {
  const v = eventSchema.parse(input);
  if (!v.id) return createEvents(a, tx, v, await validateValues(a, tx, v));
  const replay = await replayedCancellation(a, tx, v);
  if (replay) return replay;
  const { row, values, now } = await loadForEdit(a, tx, v);
  if (v.scope === "THIS") return editOccurrence(a, tx, v, row, values);
  if (!row.seriesId)
    throw new DomainError("This event is not part of a recurring series.", 422);
  return editSeries(a, tx, v, row, values, now);
}
export async function saveCalendarEvent(a: Actor, input: unknown) {
  requireCapability(a, "calendar.manage");
  return unit(a, (tx) => saveEventTx(a, tx, input));
}
/**
 * DEC-3: server preview of cancelling the following / all occurrences of a series. Read-only: it runs the same
 * checks and takes the same locks as the cancellation (inside unit()), writes nothing, and returns the occurrences
 * that would be cancelled, the individually changed ones that would stay scheduled (dates, count and changed
 * fields), and the token the cancellation must carry.
 */
export async function previewCalendarCancellation(a: Actor, input: unknown) {
  requireCapability(a, "calendar.manage");
  return unit(a, async (tx) => {
    const v = eventSchema.parse(input);
    if (!v.id || !v.cancel || v.scope === "THIS")
      throw new DomainError("A preview is only needed when cancelling the following or all occurrences of a series.", 422);
    const { row, values, now } = await loadForEdit(a, tx, v);
    if (!row.seriesId)
      throw new DomainError("This event is not part of a recurring series.", 422);
    if (FIELDS.some((f) => f !== "playerIds" && !sameValue(row.data[f], values[f])))
      throw new DomainError("Cancel the occurrences without changing other fields, or save the changes first.", 422);
    const { series, members } = await lockSeries(a, tx, v, row);
    const plan = cancellationPlan(a, v, row, series, members, now);
    return {
      seriesId: series.id,
      seriesVersion: series.version,
      occurrenceId: row.id,
      scope: v.scope,
      overwriteExceptions: v.overwriteExceptions,
      cancel: plan.cancel.map(occurrenceOf),
      cancelCount: plan.cancel.length,
      skipped: plan.skipped.map((m) => ({ ...occurrenceOf(m), fields: m.data.overrides ?? [] })),
      skippedCount: plan.skipped.length,
      previewToken: plan.token,
    };
  });
}
export async function scheduleSession(a: Actor, input: unknown) {
  requireCapability(a, "sessions.schedule");
  const v = z
    .object({
      id: z.string(),
      version: z.number().int(),
      localDate: z.string(),
      localTime: z.string(),
      repeatWeeks: z.number().int().min(1).max(12),
      duplicate: z.boolean(),
    })
    .parse(input);
  return unit(a, async (tx) => {
    const [source] = await tx
      .select()
      .from(t.trainingSessions)
      .where(
        and(
          eq(t.trainingSessions.academyId, a.academyId),
          eq(t.trainingSessions.id, v.id),
        ),
      );
    if (!source || (a.role === "COACH" && source.coachId !== a.id))
      throw new DomainError("Session not found.", 404);
    expectVersion(source.version, v.version);
    if (!v.duplicate && !["DRAFT", "PUBLISHED"].includes(source.status))
      throw new DomainError(
        "Only draft or published sessions can be rescheduled.",
      );
    if (!v.duplicate && v.repeatWeeks !== 1)
      throw new DomainError("Recurring sessions must be created as copies.");
    // Copies are new, upcoming work for the same coach: refuse them if they can no longer coach.
    if (v.duplicate) await requireActiveCoach(tx, a.academyId, source.coachId);
    const ids: string[] = [];
    for (let i = 0; i < v.repeatWeeks; i++) {
      const id = v.duplicate ? crypto.randomUUID() : source.id;
      const data = structuredClone(source.data);
      data.localDate = Temporal.PlainDate.from(v.localDate)
        .add({ weeks: i })
        .toString();
      data.localTime = v.localTime;
      const instant = scheduleInstant(
        data.localDate,
        data.localTime,
        data.duration,
        a.timezone,
      );
      let status = source.status;
      if (v.duplicate) {
        status = "DRAFT";
        data.startsAt = null;
        data.attendance = {};
        data.observations = [];
        data.actuals = {};
        data.recap = "";
        data.roster = [];
        data.progress = { index: 0, elapsed: 0, runningSince: null };
        data.activities = data.activities.map((activity) => ({
          ...activity,
          id: crypto.randomUUID(),
        }));
      } else if (status === "PUBLISHED") {
        data.startsAt = validatePublish(data);
        await ensureSlot(tx, a, {
          id,
          startsAt: data.startsAt,
          duration: data.duration,
          branchId: data.branchId,
          coachId: source.coachId,
          playerIds: data.roster.map((p) => p.id),
        });
      }
      // Draft occurrences are checked for conflicts too, but do not reserve time until published.
      if (v.duplicate || status === "DRAFT")
        await ensureSlot(tx, a, {
          id,
          startsAt: instant.startsAt,
          duration: data.duration,
          branchId: data.branchId,
          coachId: source.coachId,
          playerIds: data.roster.map((p) => p.id),
        });
      const version = v.duplicate ? 1 : source.version + 1;
      if (v.duplicate)
        await tx
          .insert(t.trainingSessions)
          .values({
            id,
            academyId: a.academyId,
            coachId: source.coachId,
            batchId: source.batchId,
            status,
            data,
          });
      else
        await tx
          .update(t.trainingSessions)
          .set({ data, version, updatedAt: new Date() })
          .where(
            and(
              eq(t.trainingSessions.academyId, a.academyId),
              eq(t.trainingSessions.id, id),
            ),
          );
      await tx
        .insert(t.revisions)
        .values({
          academyId: a.academyId,
          sessionId: id,
          version,
          status,
          data,
        });
      await tx
        .insert(t.audit)
        .values({
          id: crypto.randomUUID(),
          academyId: a.academyId,
          actorId: a.id,
          entityId: id,
          version,
          action: v.duplicate ? "calendar-copy" : "calendar-reschedule",
          detail: { sourceId: source.id },
        });
      ids.push(id);
    }
    return { ids };
  });
}
