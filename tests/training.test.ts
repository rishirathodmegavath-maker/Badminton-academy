import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, and } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import {
  provisionTestDatabase,
  type TestDatabase,
} from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import {
  createSession,
  mutateSession,
  bootstrap,
  createDrill,
} from "../src/modules/training/application/service";
import { sampleDrills } from "../src/modules/training/domain/sample-drills";
import {
  elapsedSeconds,
  localInstant,
  totalMinutes,
} from "../src/modules/training/domain/rules";
import type { Actor } from "../src/modules/identity/access";
import type { TrainingSession } from "../src/modules/training/domain/types";
process.env.BETTER_AUTH_SECRET =
  "test-only-secret-never-for-production-123456789";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3000";
// The database is provisioned in before(): embedded PGlite by default, or a fresh database on the
// disposable PostgreSQL server when TEST_POSTGRES_ADMIN_URL is set (npm run test:pg).
let testDb: TestDatabase | undefined;
const a: Actor = {
  id: "a",
  name: "Coach A",
  academyId: "a",
  role: "COACH",
  timezone: "Asia/Kolkata",
  academyName: "Academy A",
};
const b: Actor = {
  ...a,
  id: "b",
  name: "Coach B",
  academyId: "b",
  academyName: "Academy B",
};
const other: Actor = { ...a, id: "other" };
before(async () => {
  testDb = await provisionTestDatabase("training");
  const db = database();
  for (const actor of [a, b]) {
    await db.insert(t.user).values({
      id: actor.id,
      name: actor.name,
      email: `${actor.id}@example.test`,
    });
    await db.insert(t.academies).values({
      id: actor.academyId,
      name: actor.academyName,
      timezone: actor.timezone,
    });
    await db
      .insert(t.memberships)
      .values({ userId: actor.id, academyId: actor.academyId, role: "COACH" });
    await db
      .insert(t.branches)
      .values({ id: actor.id, academyId: actor.academyId, name: "Branch" });
    await db.insert(t.batches).values({
      id: actor.id,
      academyId: actor.academyId,
      coachId: actor.id,
      branchId: actor.id,
      name: "Batch",
    });
    await db.insert(t.players).values({
      id: `${actor.id}-player`,
      academyId: actor.academyId,
      batchId: actor.id,
      name: "Fictional player",
    });
  }
  await db
    .insert(t.user)
    .values({ id: "other", name: "Other coach", email: "other@example.test" });
  await db
    .insert(t.memberships)
    .values({ userId: "other", academyId: a.academyId, role: "COACH" });
  for (const drill of sampleDrills)
    await db.insert(t.drills).values({ id: drill.id, version: 1, data: drill });
});
after(async () => {
  await testDb?.cleanup();
});
let plannedIndex=0;
async function planned(): Promise<TrainingSession> {
  let s = await createSession(a);
  return mutateSession(a, s.id, {
    version: s.version,
    action: "save",
    payload: {
      ...s.data,
      title: "Test training",
      batchId: "a",
      branchId: "a",
      coachId: "a",
      localDate: new Date(Date.UTC(2026,9,16+plannedIndex++)).toISOString().slice(0,10),
      localTime: "17:00",
      duration: 15,
      objective: "Controlled recovery",
      activities: [
        {
          id: "activity-1",
          drillId: sampleDrills[0].id,
          drillVersion: 1,
          title: "ignored",
          minutes: 15,
          cues: "Recover calmly.",
        },
      ],
    },
  });
}
async function published() {
  const s = await planned();
  return mutateSession(a, s.id, { version: s.version, action: "publish" });
}
test("incomplete empty drafts persist and cannot publish", async () => {
  const s = await createSession(a);
  assert.equal(s.data.activities.length, 0);
  const saved = await mutateSession(a, s.id, {
    version: s.version,
    action: "save",
    payload: s.data,
  });
  assert.equal(saved.data.title, "");
  await assert.rejects(() =>
    mutateSession(a, s.id, { version: saved.version, action: "publish" }),
  );
  const [read] = await database()
    .select()
    .from(t.trainingSessions)
    .where(eq(t.trainingSessions.id, s.id));
  assert.equal(read.version, saved.version);
});
test("cross-academy and unassigned coach reads/writes fail", async () => {
  const s = await planned();
  assert.ok(!(await bootstrap(b)).sessions.some((x) => x.id === s.id));
  assert.ok(!(await bootstrap(other)).sessions.some((x) => x.id === s.id));
  for (const actor of [b, other])
    await assert.rejects(
      () => mutateSession(actor, s.id, { version: s.version, action: "start" }),
      /not found/,
    );
  await assert.rejects(() =>
    mutateSession(a, s.id, {
      version: s.version,
      action: "save",
      payload: { ...s.data, batchId: "b", branchId: "b", coachId: "b" },
    }),
  );
});
test("publish rejects duration mismatch and snapshots immutable drill content", async () => {
  let s = await planned();
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "save",
    payload: { ...s.data, duration: 60 },
  });
  await assert.rejects(
    () => mutateSession(a, s.id, { version: s.version, action: "publish" }),
    /minutes must match/,
  );
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "save",
    payload: { ...s.data, duration: 15 },
  });
  s = await mutateSession(a, s.id, { version: s.version, action: "publish" });
  assert.equal(s.data.startsAt, localInstant(s.data.localDate,'17:00','Asia/Kolkata'));
  assert.equal(s.data.roster.length, 1);
  assert.equal(s.data.activities[0].snapshot?.title, "Clear & recover");
  await assert.rejects(
    () =>
      mutateSession(a, s.id, {
        version: s.version,
        action: "save",
        payload: s.data,
      }),
    /Cannot save/,
  );
});
test("optimistic concurrency allows only one writer", async () => {
  const s = await planned();
  const results = await Promise.allSettled([
    mutateSession(a, s.id, {
      version: s.version,
      action: "save",
      payload: { ...s.data, title: "One" },
    }),
    mutateSession(a, s.id, {
      version: s.version,
      action: "save",
      payload: { ...s.data, title: "Two" },
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
});
test("starting does not mark attendance or activities; pause/resume is persisted", async () => {
  let s = await published();
  s = await mutateSession(a, s.id, { version: s.version, action: "start" });
  assert.deepEqual(s.data.attendance, {});
  assert.deepEqual(s.data.actuals, {});
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "progress",
    payload: { operation: "pause" },
  });
  assert.equal(s.data.progress.runningSince, null);
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "progress",
    payload: { operation: "resume" },
  });
  assert.ok(s.data.progress.runningSince);
  await assert.rejects(
    () => mutateSession(a, s.id, { version: s.version, action: "start" }),
    /Cannot start/,
  );
});
test("attendance is idempotent, auditable, and rejects players outside roster", async () => {
  let s = await published();
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "attendance",
    payload: { "a-player": "ABSENT" },
  });
  const version = s.version;
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "attendance",
    payload: { "a-player": "ABSENT" },
  });
  assert.equal(s.version, version);
  await assert.rejects(() =>
    mutateSession(a, s.id, {
      version: s.version,
      action: "attendance",
      payload: { "b-player": "PRESENT" },
    }),
  );
  const events = await database()
    .select()
    .from(t.audit)
    .where(and(eq(t.audit.entityId, s.id), eq(t.audit.action, "attendance")));
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].detail, { changes: { "a-player": "ABSENT" } });
});
test("completion requires actuals and attendance review; duplicate clears evidence", async () => {
  let s = await published();
  s = await mutateSession(a, s.id, { version: s.version, action: "start" });
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "note",
    payload: {
      id: crypto.randomUUID(),
      playerId: "a-player",
      activityId: "activity-1",
      text: "Balanced recovery during slow feeds.",
    },
  });
  assert.equal(s.data.observations[0].visibility, "PRIVATE_DRAFT");
  await assert.rejects(
    () =>
      mutateSession(a, s.id, {
        version: s.version,
        action: "complete",
        payload: { actuals: {}, recap: "", acknowledgeAttendance: true },
      }),
    /every planned/,
  );
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "complete",
    payload: {
      actuals: { "activity-1": "MODIFIED" },
      recap: "Reduced feed speed.",
      acknowledgeAttendance: true,
    },
  });
  assert.equal(s.status, "COMPLETED");
  const copy = await mutateSession(a, s.id, {
    version: s.version,
    action: "duplicate",
    payload: { localDate: "2026-10-20", localTime: "16:00" },
  });
  assert.equal(copy.status, "DRAFT");
  assert.deepEqual(copy.data.observations, []);
  assert.deepEqual(copy.data.attendance, {});
  assert.deepEqual(copy.data.actuals, {});
  assert.deepEqual(copy.data.roster, []);
  assert.equal(copy.data.progress.runningSince, null);
  assert.notEqual(copy.data.activities[0].id, s.data.activities[0].id);
  assert.equal(copy.data.activities[0].snapshot?.version, 1);
});
test("cancelled sessions cannot start and retain audit history", async () => {
  let s = await published();
  s = await mutateSession(a, s.id, {
    version: s.version,
    action: "cancel",
    payload: { reason: "Academy closure" },
  });
  await assert.rejects(
    () => mutateSession(a, s.id, { version: s.version, action: "start" }),
    /Cannot start/,
  );
  const records = await database()
    .select()
    .from(t.revisions)
    .where(eq(t.revisions.sessionId, s.id));
  assert.equal(records.length, s.version);
});
test("academy custom drills are private", async () => {
  const base = sampleDrills[0];
  const created = await createDrill(a, { ...base, title: "Private drill" });
  assert.ok((await bootstrap(a)).drills.some((d) => d.id === created.id));
  assert.ok(!(await bootstrap(b)).drills.some((d) => d.id === created.id));
});
test("PostgreSQL composite foreign keys reject cross-academy players", async () => {
  await assert.rejects(() =>
    database()
      .insert(t.players)
      .values({ id: "bad", academyId: "a", batchId: "b", name: "Bad link" }),
  );
});
test("local schedule rejects DST gaps and ambiguous instants", () => {
  assert.throws(
    () => localInstant("2026-03-08", "02:30", "America/New_York"),
    /Ambiguous/,
  );
  assert.throws(
    () => localInstant("2026-11-01", "01:30", "America/New_York"),
    /Ambiguous/,
  );
  assert.equal(
    localInstant("2026-10-16", "17:00", "America/New_York"),
    "2026-10-16T21:00:00Z",
  );
});
test("timer derives from server timestamps and totals count explicit rest", () => {
  assert.equal(
    elapsedSeconds(
      { index: 0, elapsed: 5, runningSince: "2026-10-16T10:00:00Z" },
      Date.parse("2026-10-16T10:00:10Z"),
    ),
    15,
  );
  assert.equal(totalMinutes([{ minutes: 10 }, { minutes: 5 }]), 15);
});

test("published roster and drill snapshots survive later source changes", async () => {
  const s = await published();
  const db = database();
  await db
    .insert(t.batches)
    .values({
      id: "transfer-batch",
      academyId: "a",
      name: "Next batch",
      coachId: "a",
      branchId: "a",
    })
    .onConflictDoNothing();
  try {
    await db
      .update(t.players)
      .set({ batchId: "transfer-batch" })
      .where(and(eq(t.players.academyId, "a"), eq(t.players.id, "a-player")));
    await db
      .insert(t.drills)
      .values({
        id: sampleDrills[0].id,
        version: 2,
        data: { ...sampleDrills[0], version: 2, title: "Revised curriculum" },
      })
      .onConflictDoNothing();
    const marked = await mutateSession(a, s.id, {
      version: s.version,
      action: "attendance",
      payload: { "a-player": "EXCUSED" },
    });
    assert.equal(marked.data.roster[0].id, "a-player");
    assert.equal(marked.data.activities[0].snapshot?.title, "Clear & recover");
    assert.equal(marked.data.activities[0].drillVersion, 1);
  } finally {
    await db
      .update(t.players)
      .set({ batchId: "a" })
      .where(and(eq(t.players.academyId, "a"), eq(t.players.id, "a-player")));
  }
});
