import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_RECOVERY,
  classifyDraft,
  clearDraft,
  collectGarbage,
  draftFields,
  draftKey,
  listDrafts,
  purgeScope,
  readDraft,
  restoreData,
  writeDraft,
  type DraftScope,
  type StorageLike,
} from "../src/modules/training/domain/draft-recovery";
import type {
  Drill,
  SessionData,
  TrainingSession,
} from "../src/modules/training/domain/types";

/**
 * Stage 4: the local recovery copy of unsaved training-session edits (pure logic; the browser storage is injected).
 * The server stays authoritative, so these tests are about what is kept, for whom, for how long, and what is never
 * offered back.
 */
class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  failWrites = false;
  failReads = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    if (this.failReads) throw new Error("storage unreadable");
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  keys() {
    return [...this.map.keys()];
  }
  raw(k: string) {
    return this.map.get(k);
  }
}

const NOW = Date.parse("2026-11-06T12:00:00Z");
const green: DraftScope = { academyId: "academy-green", userId: "coach-aman" };
const blue: DraftScope = { academyId: "academy-blue", userId: "coach-maya" };
const otherUser: DraftScope = {
  academyId: "academy-green",
  userId: "coach-other",
};
const CANARY = "PRIVATE-CANARY-7f3a";

const data = (over: Partial<SessionData> = {}): SessionData => ({
  title: "Overhead technique",
  batchId: "batch-1",
  branchId: "branch-1",
  coachId: "coach-aman",
  localDate: "2030-01-05",
  localTime: "17:00",
  startsAt: null,
  timezone: "Asia/Kolkata",
  duration: 60,
  objective: "Recover to base",
  activities: [
    {
      id: "a1",
      drillId: "d1",
      drillVersion: 1,
      title: "Clear",
      minutes: 30,
      cues: "turn",
      snapshot: null,
    },
    {
      id: "a2",
      drillId: "d2",
      drillVersion: 1,
      title: "Smash",
      minutes: 30,
      cues: "snap",
      snapshot: null,
    },
  ],
  roster: [{ id: "p1", name: `Player ${CANARY}` }],
  attendance: { p1: "PRESENT" },
  observations: [
    {
      id: "o1",
      playerId: "p1",
      activityId: null,
      text: `note ${CANARY}`,
      author: "Coach",
      at: "x",
      visibility: "PRIVATE_DRAFT",
    },
  ],
  adjustments: [{ playerId: "p1", focus: "footwork" }],
  progress: { index: 0, elapsed: 0, runningSince: null },
  actuals: {},
  recap: `recap ${CANARY}`,
  ...over,
});
const session = (
  over: Partial<TrainingSession> = {},
  d: Partial<SessionData> = {},
): TrainingSession => ({
  id: "s1",
  academyId: "academy-green",
  version: 2,
  status: "DRAFT",
  data: data(d),
  updatedAt: "2026-11-06T10:00:00.000Z",
  ...over,
});
const drill = (id: string): Drill =>
  ({
    id,
    version: 1,
    academyId: null,
    title: id,
    skill: "",
    level: "",
    format: "",
    minutes: 10,
    players: 2,
    equipment: [],
    objective: "",
    setup: "",
    steps: [],
    cues: [],
    mistakes: [],
    easier: "",
    harder: "",
    review: "",
  }) as Drill;

test("keys are scoped to academy, user and session, whatever characters the identifiers contain", () => {
  const a = draftKey(green, "s1");
  assert.notEqual(a, draftKey(blue, "s1"));
  assert.notEqual(a, draftKey(otherUser, "s1"));
  assert.notEqual(a, draftKey(green, "s2"));
  // a ':' or a prefix of another identifier cannot make two different owners collide
  assert.notEqual(
    draftKey({ academyId: "a:b", userId: "c" }, "s"),
    draftKey({ academyId: "a", userId: "b:c" }, "s"),
  );
  assert.ok(a.startsWith(DRAFT_RECOVERY.prefix));
});

test("only the editable fields are kept: no attendance, observations, roster, recap, or anything private", () => {
  const store = new MemoryStorage();
  const w = writeDraft(store, green, session(), NOW, "tab-1");
  assert.equal(w.ok, true);
  const raw = store.raw(draftKey(green, "s1"))!;
  assert.ok(
    !raw.includes(CANARY),
    "private session content must never reach the recovery copy",
  );
  const parsed = JSON.parse(raw);
  assert.deepEqual(Object.keys(parsed.draft).sort(), [
    "activities",
    "adjustments",
    "batchId",
    "branchId",
    "coachId",
    "duration",
    "localDate",
    "localTime",
    "objective",
    "title",
  ]);
  // activity snapshots (whole drill texts) are not copied either
  assert.deepEqual(Object.keys(parsed.draft.activities[0]).sort(), [
    "cues",
    "drillId",
    "drillVersion",
    "id",
    "minutes",
    "title",
  ]);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.baseVersion, 2);
  assert.equal(parsed.baseUpdatedAt, "2026-11-06T10:00:00.000Z");
  assert.equal(parsed.savedAt, new Date(NOW).toISOString());
});

test("a copy round-trips for its owner and for nobody else", () => {
  const store = new MemoryStorage();
  writeDraft(store, green, session(), NOW, "tab-1");
  const mine = readDraft(store, green, "s1", NOW);
  assert.equal(mine.status, "ok");
  if (mine.status === "ok")
    assert.equal(mine.record.draft.title, "Overhead technique");
  // another person, another academy, another session: nothing
  assert.deepEqual(readDraft(store, otherUser, "s1", NOW), { status: "none" });
  assert.deepEqual(readDraft(store, blue, "s1", NOW), { status: "none" });
  assert.deepEqual(readDraft(store, green, "s2", NOW), { status: "none" });
  assert.deepEqual(listDrafts(store, otherUser, NOW), []);
  assert.deepEqual(listDrafts(store, blue, NOW), []);
  assert.equal(listDrafts(store, green, NOW).length, 1);
  // one person's sign-out purge never touches another person's copies
  writeDraft(store, otherUser, session({ id: "s9" }), NOW, "tab-2");
  assert.equal(purgeScope(store, green), 1);
  assert.equal(listDrafts(store, green, NOW).length, 0);
  assert.equal(listDrafts(store, otherUser, NOW).length, 1);
});

test("a copy planted under someone else's key is recognised by its content and refused", () => {
  const store = new MemoryStorage();
  writeDraft(store, green, session(), NOW, "tab-1");
  const planted = store.raw(draftKey(green, "s1"))!;
  for (const [scope, id] of [
    [otherUser, "s1"],
    [blue, "s1"],
    [green, "s-other"],
  ] as const) {
    store.setItem(draftKey(scope, id), planted);
    const r = readDraft(store, scope, id, NOW);
    assert.deepEqual(
      r,
      { status: "invalid", reason: "wrong-owner" },
      `${scope.userId}/${id}`,
    );
    assert.equal(
      store.getItem(draftKey(scope, id)),
      null,
      "refused copies are removed",
    );
  }
  assert.equal(
    readDraft(store, green, "s1", NOW).status,
    "ok",
    "the genuine copy is untouched",
  );
});

test("malformed, outdated, oversized and tampered data is rejected safely and removed", () => {
  const store = new MemoryStorage();
  writeDraft(store, green, session(), NOW, "tab-1");
  const good = JSON.parse(store.raw(draftKey(green, "s1"))!);
  const cases: Record<string, unknown> = {
    "not json": "{{{",
    "empty string": "",
    "json null": "null",
    array: "[]",
    "other format version": { ...good, v: 2 },
    "old format version": { ...good, v: 0 },
    "missing draft": { ...good, draft: undefined },
    "extra top-level field": { ...good, token: "x" },
    "extra draft field": { ...good, draft: { ...good.draft, attendance: {} } },
    "wrong type": { ...good, draft: { ...good.draft, duration: "60" } },
    "non-finite number": { ...good, draft: { ...good.draft, duration: 1e999 } },
    "title too long": {
      ...good,
      draft: { ...good.draft, title: "x".repeat(121) },
    },
    "too many activities": {
      ...good,
      draft: {
        ...good.draft,
        activities: Array.from({ length: 61 }, (_, i) => ({
          id: `a${i}`,
          drillId: null,
          drillVersion: null,
          title: "t",
          minutes: 1,
          cues: "",
        })),
      },
    },
    "base version zero": { ...good, baseVersion: 0 },
    "fractional base version": { ...good, baseVersion: 1.5 },
  };
  for (const [name, value] of Object.entries(cases)) {
    store.setItem(
      draftKey(green, "s1"),
      typeof value === "string" ? value : JSON.stringify(value),
    );
    const r = readDraft(store, green, "s1", NOW);
    assert.equal(r.status, "invalid", name);
    assert.equal(
      store.getItem(draftKey(green, "s1")),
      null,
      `${name}: removed`,
    );
  }
  // a record larger than the bound is refused before it is even parsed
  store.setItem(
    draftKey(green, "s1"),
    "x".repeat(DRAFT_RECOVERY.maxRecordChars + 1),
  );
  assert.equal(readDraft(store, green, "s1", NOW).status, "invalid");
});

test("copies expire after 14 days; a future-dated copy is not trusted", () => {
  const store = new MemoryStorage();
  writeDraft(store, green, session(), NOW, "tab-1");
  assert.equal(
    readDraft(store, green, "s1", NOW + DRAFT_RECOVERY.maxAgeMs - 1000).status,
    "ok",
  );
  assert.deepEqual(
    readDraft(store, green, "s1", NOW + DRAFT_RECOVERY.maxAgeMs + 1000),
    { status: "invalid", reason: "expired" },
  );
  assert.equal(store.getItem(draftKey(green, "s1")), null);
  writeDraft(store, green, session(), NOW + 3 * 24 * 3600 * 1000, "tab-1");
  assert.deepEqual(
    readDraft(store, green, "s1", NOW),
    { status: "invalid", reason: "expired" },
    "a clock far in the past makes the copy untrustworthy",
  );
});

test("the number of copies and the size of each copy are bounded", () => {
  const store = new MemoryStorage();
  for (let i = 0; i < DRAFT_RECOVERY.maxPerScope + 5; i++)
    writeDraft(store, green, session({ id: `s${i}` }), NOW + i * 1000, "tab-1");
  const kept = listDrafts(store, green, NOW + 60_000);
  assert.equal(kept.length, DRAFT_RECOVERY.maxPerScope);
  assert.ok(
    !kept.some((r) => r.sessionId === "s0"),
    "the oldest copies are dropped first",
  );
  assert.ok(
    kept.some((r) => r.sessionId === `s${DRAFT_RECOVERY.maxPerScope + 4}`),
  );
  // the largest copy the existing draft schema allows still fits...
  const largest = session(
    {},
    {
      objective: "x".repeat(2000),
      activities: Array.from({ length: 60 }, (_, i) => ({
        id: "i".repeat(100),
        drillId: null,
        drillVersion: null,
        title: "t".repeat(120),
        minutes: 1,
        cues: "c".repeat(1000),
        snapshot: null,
      })),
      adjustments: Array.from({ length: 100 }, (_, i) => ({
        playerId: `p${i}`,
        focus: "f".repeat(500),
        goalId: "g".repeat(100),
      })),
    },
  );
  assert.equal(writeDraft(store, green, largest, NOW, "tab-1").ok, true);
  // ...and something far beyond the schema is refused instead of filling the browser's storage
  const absurd = session(
    {},
    {
      adjustments: Array.from({ length: 100 }, (_, i) => ({
        playerId: `p${i}`,
        focus: "f".repeat(5000),
      })),
    },
  );
  assert.deepEqual(writeDraft(store, green, absurd, NOW, "tab-1"), {
    ok: false,
    reason: "too-large",
  });
});

test("storage that is missing, full or unreadable never throws and never loses the in-memory draft", () => {
  assert.deepEqual(writeDraft(null, green, session(), NOW, "t"), {
    ok: false,
    reason: "unavailable",
  });
  assert.deepEqual(readDraft(null, green, "s1", NOW), { status: "none" });
  assert.deepEqual(listDrafts(null, green, NOW), []);
  assert.equal(purgeScope(null, green), 0);
  assert.equal(collectGarbage(null, NOW), 0);
  clearDraft(null, green, "s1");
  const full = new MemoryStorage();
  full.failWrites = true;
  assert.deepEqual(writeDraft(full, green, session(), NOW, "t"), {
    ok: false,
    reason: "unavailable",
  });
  const broken = new MemoryStorage();
  writeDraft(broken, green, session(), NOW, "t");
  broken.failReads = true;
  assert.deepEqual(readDraft(broken, green, "s1", NOW), { status: "none" });
  assert.deepEqual(listDrafts(broken, green, NOW), []);
});

test("only drafts of the person's own academy can be written", () => {
  const store = new MemoryStorage();
  assert.deepEqual(
    writeDraft(store, green, session({ academyId: "academy-blue" }), NOW, "t"),
    { ok: false, reason: "not-a-draft" },
  );
  assert.deepEqual(
    writeDraft(store, green, session({ status: "PUBLISHED" }), NOW, "t"),
    { ok: false, reason: "not-a-draft" },
  );
  assert.equal(store.length, 0);
});

test("a half-typed value (duration 0) is still recoverable; the server re-checks every limit when it is saved", () => {
  const store = new MemoryStorage();
  assert.equal(
    writeDraft(
      store,
      green,
      session({}, { duration: 0, title: "  spaced  " }),
      NOW,
      "t",
    ).ok,
    true,
  );
  const r = readDraft(store, green, "s1", NOW);
  assert.equal(r.status, "ok");
  if (r.status === "ok") {
    assert.equal(r.record.draft.duration, 0);
    assert.equal(
      r.record.draft.title,
      "  spaced  ",
      "text is restored exactly as typed",
    );
  }
});

test("garbage collection removes what nobody could ever restore, and only that", () => {
  const store = new MemoryStorage();
  writeDraft(store, green, session(), NOW, "t");
  writeDraft(
    store,
    blue,
    session({ id: "s7", academyId: "academy-blue" }),
    NOW,
    "t",
  );
  store.setItem("sportozen.training-draft.v0:legacy", "old format");
  store.setItem(`${DRAFT_RECOVERY.prefix}broken`, "{");
  store.setItem("unrelated.key", "keep me");
  writeDraft(
    store,
    otherUser,
    session({ id: "s8" }),
    NOW - 20 * 24 * 3600 * 1000,
    "t",
  ); // expired
  const removed = collectGarbage(store, NOW);
  assert.equal(removed, 3);
  assert.equal(store.getItem("unrelated.key"), "keep me");
  assert.equal(readDraft(store, green, "s1", NOW).status, "ok");
  assert.equal(
    readDraft(store, blue, "s7", NOW).status,
    "ok",
    "valid copies of other people are not touched",
  );
});

test("a confirmed save removes the copy, but not a copy written by another tab", () => {
  const store = new MemoryStorage();
  writeDraft(store, green, session(), NOW, "tab-A");
  clearDraft(store, green, "s1", "tab-B");
  assert.equal(
    readDraft(store, green, "s1", NOW).status,
    "ok",
    "tab B's save must not delete tab A's unsaved edits",
  );
  clearDraft(store, green, "s1", "tab-A");
  assert.deepEqual(readDraft(store, green, "s1", NOW), { status: "none" });
  writeDraft(store, green, session(), NOW, "tab-A");
  clearDraft(store, green, "s1"); // an explicit discard removes it whoever wrote it
  assert.deepEqual(readDraft(store, green, "s1", NOW), { status: "none" });
});

test("stale-draft detection reuses the saved version counter and distinguishes the four situations", () => {
  const store = new MemoryStorage();
  writeDraft(
    store,
    green,
    session({ version: 3 }, { title: "Local edit" }),
    NOW,
    "t",
  );
  const r = readDraft(store, green, "s1", NOW);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const server = (
    v: number,
    over: Partial<TrainingSession> = {},
    d: Partial<SessionData> = {},
  ) => session({ version: v, ...over }, d);
  // same version the edits started from, different content: safe to restore and save
  assert.equal(
    classifyDraft(r.record, server(3, {}, { title: "Saved title" })),
    "current",
  );
  // the server holds exactly what the copy holds: nothing to recover
  assert.equal(
    classifyDraft(r.record, server(3, {}, { title: "Local edit" })),
    "identical",
  );
  assert.equal(
    classifyDraft(r.record, server(5, {}, { title: "Local edit" })),
    "identical",
  );
  // the server moved on: restoring and saving would replace newer changes
  assert.equal(
    classifyDraft(r.record, server(4, {}, { title: "Newer saved title" })),
    "stale",
  );
  // the session is not editable any more, or the copy claims a version the server never had
  assert.equal(
    classifyDraft(
      r.record,
      server(3, { status: "PUBLISHED" }, { title: "Saved title" }),
    ),
    "obsolete",
  );
  assert.equal(
    classifyDraft(r.record, server(3, { status: "CANCELLED" })),
    "obsolete",
  );
  assert.equal(
    classifyDraft(r.record, server(2, {}, { title: "Saved title" })),
    "obsolete",
  );
});

test("restoring applies the edits onto the latest server data, never onto stale local state, and keeps private content out", () => {
  const store = new MemoryStorage();
  writeDraft(
    store,
    green,
    session(
      { version: 2 },
      { title: "Local edit", objective: "Local objective" },
    ),
    NOW,
    "t",
  );
  const r = readDraft(store, green, "s1", NOW);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  const latest = session(
    { version: 4 },
    {
      title: "Server title",
      attendance: { p1: "ABSENT" },
      recap: "server recap",
      activities: [
        {
          id: "a1",
          drillId: "d1",
          drillVersion: 1,
          title: "Clear",
          minutes: 30,
          cues: "old",
          snapshot: drill("d1"),
        },
      ],
    },
  );
  const out = restoreData(latest, r.record, [drill("d2")]);
  assert.equal(out.title, "Local edit");
  assert.equal(out.objective, "Local objective");
  assert.deepEqual(
    out.attendance,
    { p1: "ABSENT" },
    "fields the builder does not edit come from the server",
  );
  assert.equal(out.recap, "server recap");
  assert.equal(out.activities.length, 2);
  assert.equal(
    out.activities[0].snapshot?.id,
    "d1",
    "an activity the server already knows keeps its stored snapshot",
  );
  assert.equal(
    out.activities[1].snapshot?.id,
    "d2",
    "a new one gets the drill's details from the library",
  );
  assert.deepEqual(
    draftFields(out),
    r.record.draft,
    "what was recovered is exactly what was kept",
  );
});
