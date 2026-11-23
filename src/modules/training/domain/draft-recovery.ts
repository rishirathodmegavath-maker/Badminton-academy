import { z } from "zod";
import { activityInput, draftInput } from "./rules";
import type { Drill, SessionData, TrainingSession } from "./types";

/**
 * Local recovery copies of unsaved training-session edits.
 *
 * The server stays authoritative: a copy is only ever a *proposal* that the person restores into the editor and then
 * saves through the normal `save` action (same validation, same authorisation, same `version` check). Nothing in this
 * file talks to the network or to the DOM; the browser storage is passed in, which keeps it testable.
 *
 * What is kept: only the fields the session builder edits (title, batch/branch/coach, date, time, duration,
 * objective, activities, player focus). Never attendance, observations, recap, roster, tokens or e-mail addresses.
 * Where: one record per (academy, user, session) so a copy can only ever be offered back to the same person in the
 * same academy for the same session. Lifetime: removed on a confirmed save, an explicit discard, sign-out, expiry
 * (14 days), or when the session is no longer visible to that person.
 */
export const DRAFT_RECOVERY = {
  version: 1,
  prefix: "sportozen.training-draft.v1:",
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxPerScope: 10,
  maxRecordChars: 200_000,
} as const;

export type DraftScope = { academyId: string; userId: string };

/**
 * The existing `draftInput` shape, with the numeric business limits relaxed. A half-typed duration (0, empty) is a
 * legitimate in-progress state that must still be recoverable; the server's own schema re-checks every limit when
 * the person saves. Every other bound (lengths, counts, field types) is inherited from the existing schema.
 */
const recoverableDraft = draftInput
  .extend({
    title: z.string().max(120),
    duration: z.number().finite().min(0).max(100_000),
    activities: z
      .array(
        activityInput
          .extend({ minutes: z.number().finite().min(0).max(100_000) })
          .strict(),
      )
      .max(60),
  })
  .strict();
export type DraftFields = z.infer<typeof recoverableDraft>;

const recordSchema = z
  .object({
    v: z.literal(DRAFT_RECOVERY.version),
    academyId: z.string().min(1).max(100),
    userId: z.string().min(1).max(100),
    sessionId: z.string().min(1).max(100),
    /** The saved version the edits were started from (the same `version` the server compares on save). */
    baseVersion: z.number().int().min(1),
    baseUpdatedAt: z.string().max(40),
    savedAt: z.string().max(40),
    /** Which open tab wrote this copy, so one tab's confirmed save cannot delete another tab's unsaved edits. */
    writer: z.string().max(64),
    draft: recoverableDraft,
  })
  .strict();
export type DraftRecord = z.infer<typeof recordSchema>;

export type StorageLike = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

const enc = encodeURIComponent;
const scopePrefix = (scope: DraftScope) =>
  `${DRAFT_RECOVERY.prefix}${enc(scope.academyId)}:${enc(scope.userId)}:`;
export const draftKey = (scope: DraftScope, sessionId: string) =>
  `${scopePrefix(scope)}${enc(sessionId)}`;

/** The editable fields of a session, in a fixed key order (so two equal drafts serialise identically). */
export function draftFields(data: SessionData): DraftFields {
  return {
    title: data.title,
    batchId: data.batchId,
    branchId: data.branchId,
    coachId: data.coachId,
    localDate: data.localDate,
    localTime: data.localTime,
    duration: data.duration,
    objective: data.objective,
    activities: data.activities.map((a) => ({
      id: a.id,
      drillId: a.drillId,
      drillVersion: a.drillVersion,
      title: a.title,
      minutes: a.minutes,
      cues: a.cues,
    })),
    adjustments: data.adjustments.map((a) => ({
      playerId: a.playerId,
      focus: a.focus,
      ...(a.goalId ? { goalId: a.goalId } : {}),
    })),
  };
}
export const sameDraft = (a: DraftFields, b: DraftFields) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Applies a recovered draft onto the session as the server currently holds it (never onto stale local state). */
export function restoreData(
  server: TrainingSession,
  record: DraftRecord,
  drills: Drill[],
): SessionData {
  const known = new Map(server.data.activities.map((a) => [a.id, a]));
  return {
    ...server.data,
    ...record.draft,
    activities: record.draft.activities.map((a) => ({
      ...a,
      snapshot:
        known.get(a.id)?.snapshot ??
        drills.find((d) => d.id === a.drillId) ??
        null,
    })),
  };
}

export type DraftWrite =
  | { ok: true; record: DraftRecord }
  | { ok: false; reason: "unavailable" | "too-large" | "not-a-draft" };

/** Stores (or replaces) the recovery copy for the session being edited. `session.version` is the base version. */
export function writeDraft(
  storage: StorageLike | null,
  scope: DraftScope,
  session: TrainingSession,
  now: number,
  writer: string,
): DraftWrite {
  if (!storage) return { ok: false, reason: "unavailable" };
  if (session.status !== "DRAFT" || session.academyId !== scope.academyId)
    return { ok: false, reason: "not-a-draft" };
  const record: DraftRecord = {
    v: DRAFT_RECOVERY.version,
    academyId: scope.academyId,
    userId: scope.userId,
    sessionId: session.id,
    baseVersion: session.version,
    baseUpdatedAt: session.updatedAt,
    savedAt: new Date(now).toISOString(),
    writer: writer.slice(0, 64),
    draft: draftFields(session.data),
  };
  const text = JSON.stringify(record);
  if (text.length > DRAFT_RECOVERY.maxRecordChars)
    return { ok: false, reason: "too-large" };
  try {
    storage.setItem(draftKey(scope, session.id), text);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  prune(storage, scope, now);
  return { ok: true, record };
}

export type DraftRead =
  | { status: "none" }
  | { status: "invalid"; reason: "malformed" | "expired" | "wrong-owner" }
  | { status: "ok"; record: DraftRecord };

function parseRecord(
  raw: string,
  scope: DraftScope,
  sessionId: string,
  now: number,
): DraftRead {
  if (raw.length > DRAFT_RECOVERY.maxRecordChars)
    return { status: "invalid", reason: "malformed" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "invalid", reason: "malformed" };
  }
  const parsed = recordSchema.safeParse(json);
  if (!parsed.success) return { status: "invalid", reason: "malformed" };
  const r = parsed.data;
  // The key says whose copy this is; the content must agree, or it is not offered to anyone.
  if (
    r.academyId !== scope.academyId ||
    r.userId !== scope.userId ||
    r.sessionId !== sessionId
  )
    return { status: "invalid", reason: "wrong-owner" };
  const saved = Date.parse(r.savedAt);
  if (
    !Number.isFinite(saved) ||
    now - saved > DRAFT_RECOVERY.maxAgeMs ||
    saved - now > 24 * 60 * 60 * 1000
  )
    return { status: "invalid", reason: "expired" };
  return { status: "ok", record: r };
}

/** Reads one copy. Malformed, obsolete-format, expired or mismatched copies are removed and reported, never returned. */
export function readDraft(
  storage: StorageLike | null,
  scope: DraftScope,
  sessionId: string,
  now: number,
): DraftRead {
  if (!storage) return { status: "none" };
  const key = draftKey(scope, sessionId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: "none" };
  }
  if (raw === null) return { status: "none" };
  const result = parseRecord(raw, scope, sessionId, now);
  if (result.status === "invalid") remove(storage, key);
  return result;
}

/**
 * Removes the copy for one session. With `onlyWriter` (used after a confirmed save) a copy written by a different tab is
 * left alone: that tab may hold unsaved edits of its own. Explicit discards pass nothing and remove it unconditionally.
 */
export function clearDraft(
  storage: StorageLike | null,
  scope: DraftScope,
  sessionId: string,
  onlyWriter?: string,
) {
  if (!storage) return;
  const key = draftKey(scope, sessionId);
  if (onlyWriter !== undefined) {
    try {
      const raw = storage.getItem(key);
      const parsed =
        raw === null ? null : recordSchema.safeParse(JSON.parse(raw));
      if (parsed?.success && parsed.data.writer !== onlyWriter) return;
    } catch {
      /* unreadable: nothing worth protecting */
    }
  }
  remove(storage, key);
}

/** All valid, unexpired copies of one person in one academy, newest first. Unreadable or expired ones are removed. */
export function listDrafts(
  storage: StorageLike | null,
  scope: DraftScope,
  now: number,
): DraftRecord[] {
  if (!storage) return [];
  const out: DraftRecord[] = [];
  for (const key of keysWith(storage, scopePrefix(scope))) {
    const sessionId = decodeURIComponentSafe(
      key.slice(scopePrefix(scope).length),
    );
    const r = readDraft(storage, scope, sessionId, now);
    if (r.status === "ok") out.push(r.record);
  }
  return out.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
}

/** Removes every copy of this person in this academy (sign-out on a shared device). Returns how many were removed. */
export function purgeScope(
  storage: StorageLike | null,
  scope: DraftScope,
): number {
  if (!storage) return 0;
  const keys = keysWith(storage, scopePrefix(scope));
  for (const key of keys) remove(storage, key);
  return keys.length;
}

/**
 * Removes garbage under our prefix that no one could ever restore: unparseable values, other format versions and
 * expired copies, whoever they belong to. Valid unexpired copies of other people are left untouched.
 */
export function collectGarbage(
  storage: StorageLike | null,
  now: number,
): number {
  if (!storage) return 0;
  let removed = 0;
  for (const key of keysWith(storage, "sportozen.training-draft.")) {
    let raw: string | null = null;
    try {
      raw = storage.getItem(key);
    } catch {
      continue;
    }
    const verdict = (() => {
      if (!key.startsWith(DRAFT_RECOVERY.prefix) || raw === null) return false;
      try {
        const rec = recordSchema.safeParse(JSON.parse(raw));
        if (!rec.success) return false;
        const saved = Date.parse(rec.data.savedAt);
        return Number.isFinite(saved) && now - saved <= DRAFT_RECOVERY.maxAgeMs;
      } catch {
        return false;
      }
    })();
    if (!verdict) {
      remove(storage, key);
      removed++;
    }
  }
  return removed;
}

function prune(storage: StorageLike, scope: DraftScope, now: number) {
  const all = listDrafts(storage, scope, now);
  for (const old of all.slice(DRAFT_RECOVERY.maxPerScope))
    remove(storage, draftKey(scope, old.sessionId));
}

export type DraftVerdict =
  /** Same as what the server holds: nothing to recover. */
  | "identical"
  /** The server still has the version the edits were started from: safe to restore and save. */
  | "current"
  /** The server moved on after these edits were started: restoring and saving would replace newer changes. */
  | "stale"
  /** The session is no longer a draft (or the copy is ahead of the server): cannot be saved any more. */
  | "obsolete";

export function classifyDraft(
  record: DraftRecord,
  server: TrainingSession,
): DraftVerdict {
  if (server.status !== "DRAFT") return "obsolete";
  if (record.baseVersion > server.version) return "obsolete";
  if (sameDraft(record.draft, draftFields(server.data))) return "identical";
  return record.baseVersion === server.version ? "current" : "stale";
}

function keysWith(storage: StorageLike, prefix: string): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
  } catch {
    /* storage unreadable: nothing to list */
  }
  return keys;
}
function remove(storage: StorageLike, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function decodeURIComponentSafe(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
