import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { sampleDrills } from "../src/modules/training/domain/sample-drills";
import {
  FIXTURE_PASSWORD,
  ROLES,
  ROLE_USER,
  USERS,
  addFixtureUser,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import type { TestClient } from "./helpers/client";

/**
 * Stage 4: the server side of draft recovery. A recovered local draft is only a proposal; it reaches the academy through
 * the same `save` action as any edit, so the existing `version` check, validation and authorisation decide the outcome.
 * These tests pin that: a stale save is refused and changes nothing, a retry at the current version works, two writers
 * cannot both win, and no other person, academy or role can read or write someone's draft.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("training-draft-concurrency");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const db = () => database();

type Session = {
  id: string;
  version: number;
  status: string;
  data: {
    title: string;
    objective: string;
    duration: number;
    activities: { id: string }[];
  };
};
const json = <T>(r: { json: unknown }) => r.json as T;
const err = (r: { json: unknown }) =>
  (r.json ?? {}) as { error?: string; code?: string };
const payload = (coachId: string, over: Record<string, unknown> = {}) => ({
  title: "Overhead technique",
  batchId: "",
  branchId: "",
  coachId,
  localDate: "",
  localTime: "",
  duration: 60,
  objective: "Recover to base",
  activities: [],
  adjustments: [],
  ...over,
});
const create = async (c: TestClient) => {
  const r = await c.post("/api/training/sessions", {});
  assert.equal(r.status, 200, r.text);
  return json<Session>(r);
};
const save = (
  c: TestClient,
  id: string,
  version: unknown,
  body: unknown,
  action = "save",
) => c.post(`/api/training/sessions/${id}`, { version, action, payload: body });
const row = async (id: string) => {
  const [r] = await db()
    .select()
    .from(t.trainingSessions)
    .where(eq(t.trainingSessions.id, id));
  return r;
};
const revisions = async (id: string) =>
  (await db().select().from(t.revisions).where(eq(t.revisions.sessionId, id)))
    .length;
const visibleIds = async (c: TestClient) =>
  json<{ sessions: Session[] }>(await c.get("/api/training")).sessions.map(
    (s) => s.id,
  );

test("create, edit, save: the version counter advances once per confirmed save and every save is a revision", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  assert.equal(s.version, 1);
  assert.equal(s.status, "DRAFT");
  const first = await save(
    coach,
    s.id,
    1,
    payload(USERS.coach.id, { title: "First" }),
  );
  assert.equal(first.status, 200, first.text);
  assert.equal(json<Session>(first).version, 2);
  const second = await save(
    coach,
    s.id,
    2,
    payload(USERS.coach.id, { title: "Second", duration: 45 }),
  );
  assert.equal(json<Session>(second).version, 3);
  const stored = await row(s.id);
  assert.equal(stored.version, 3);
  assert.equal(stored.data.title, "Second");
  assert.equal(stored.data.duration, 45);
  assert.equal(await revisions(s.id), 3, "creation + two saves");
});

test("a stale draft is refused with a conflict and changes nothing; the same edits saved at the current version succeed", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  // another tab/person saves first (version 1 -> 2)
  assert.equal(
    (
      await save(
        coach,
        s.id,
        1,
        payload(USERS.coach.id, { title: "Newer on the server" }),
      )
    ).status,
    200,
  );
  const before = await row(s.id);
  const revisionsBefore = await revisions(s.id);

  // the recovered local draft still carries the version it was started from (1)
  const stale = await save(
    coach,
    s.id,
    1,
    payload(USERS.coach.id, { title: "Recovered local edits" }),
  );
  assert.equal(stale.status, 409);
  assert.match(err(stale).error ?? "", /changed in another tab/i);
  const after = await row(s.id);
  assert.equal(after.version, before.version, "version unchanged");
  assert.equal(
    after.data.title,
    "Newer on the server",
    "the newer server data was not overwritten",
  );
  assert.deepEqual(after.data, before.data);
  assert.equal(
    await revisions(s.id),
    revisionsBefore,
    "no revision was written",
  );

  // after the person explicitly chooses to restore their edits onto the latest version, the save is accepted
  const retry = await save(
    coach,
    s.id,
    after.version,
    payload(USERS.coach.id, { title: "Recovered local edits" }),
  );
  assert.equal(retry.status, 200, retry.text);
  assert.equal(json<Session>(retry).version, after.version + 1);
  assert.equal((await row(s.id)).data.title, "Recovered local edits");
});

test("two saves racing on the same version: exactly one wins, the other is told to reload, and no update is half-applied", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  const [a, b] = await Promise.all([
    save(coach, s.id, 1, payload(USERS.coach.id, { title: "Writer A" })),
    save(
      coach.clone(),
      s.id,
      1,
      payload(USERS.coach.id, { title: "Writer B" }),
    ),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? "Writer A" : "Writer B";
  const stored = await row(s.id);
  assert.equal(stored.version, 2);
  assert.equal(stored.data.title, winner);
  assert.equal(await revisions(s.id), 2);
});

test("a version that is not a plain positive integer never reaches the data", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  for (const version of [
    0,
    -1,
    1.5,
    "1",
    null,
    undefined,
    Number.MAX_SAFE_INTEGER + 2,
  ]) {
    const r = await save(
      coach,
      s.id,
      version,
      payload(USERS.coach.id, { title: "Bad version" }),
    );
    assert.ok(
      [400, 409, 422].includes(r.status),
      `version ${String(version)} -> ${r.status}`,
    );
  }
  assert.equal((await row(s.id)).version, 1);
  assert.equal((await row(s.id)).data.title, "");
});

test("invalid or oversized recovered drafts are rejected by the server's own validation and nothing is written", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  const bad: unknown[] = [
    payload(USERS.coach.id, { duration: 0 }),
    payload(USERS.coach.id, { duration: 481 }),
    payload(USERS.coach.id, { duration: 12.5 }),
    payload(USERS.coach.id, { title: "x".repeat(121) }),
    payload(USERS.coach.id, { objective: "x".repeat(2001) }),
    payload(USERS.coach.id, {
      activities: Array.from({ length: 61 }, (_, i) => ({
        id: `a${i}`,
        drillId: null,
        drillVersion: null,
        title: "t",
        minutes: 1,
        cues: "",
      })),
    }),
    payload(USERS.coach.id, {
      activities: [
        {
          id: "a",
          drillId: null,
          drillVersion: null,
          title: "t",
          minutes: 0,
          cues: "",
        },
      ],
    }),
    payload(USERS.coach.id, {
      activities: [
        {
          id: "dup",
          drillId: null,
          drillVersion: null,
          title: "t",
          minutes: 5,
          cues: "",
        },
        {
          id: "dup",
          drillId: null,
          drillVersion: null,
          title: "u",
          minutes: 5,
          cues: "",
        },
      ],
    }),
    { title: "missing the rest" },
    "not an object",
    null,
  ];
  for (const body of bad) {
    const r = await save(coach, s.id, 1, body);
    assert.ok(
      r.status >= 400 && r.status < 500,
      `${JSON.stringify(body).slice(0, 60)} -> ${r.status}`,
    );
  }
  const stored = await row(s.id);
  assert.equal(stored.version, 1);
  assert.equal(await revisions(s.id), 1);
  // unknown fields (a tampered recovery copy carrying attendance, say) are not written either
  const withExtra = await save(coach, s.id, 1, {
    ...payload(USERS.coach.id, { title: "Tampered" }),
    attendance: { x: "PRESENT" },
    recap: "injected",
  });
  assert.equal(withExtra.status, 200);
  const after = await row(s.id);
  assert.deepEqual(after.data.attendance, {});
  assert.equal(after.data.recap, "");
});

test("a coach cannot save a draft naming someone else as the coach", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  const r = await save(coach, s.id, 1, payload(USERS.headCoach.id));
  assert.equal(r.status, 403);
  assert.equal((await row(s.id)).version, 1);
});

test("a recovered draft cannot be saved by another person, another academy, or a role without training access", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  assert.equal(
    (await save(coach, s.id, 1, payload(USERS.coach.id, { title: "Mine" })))
      .status,
    200,
  );
  const snapshot = await row(s.id);

  // a second coach of the same academy (training sessions are private to their coach unless the viewer manages)
  const other = await addFixtureUser("fx-s4-coach-two", [
    { academyId: "green", role: "COACH" },
  ]);
  const otherClient = app.anonymous();
  assert.equal(
    (await otherClient.signIn(other.email, FIXTURE_PASSWORD)).status,
    200,
  );
  assert.ok(!(await visibleIds(otherClient)).includes(s.id), "not listed");
  assert.equal(
    (
      await save(
        otherClient,
        s.id,
        snapshot.version,
        payload(other.id, { title: "Theirs" }),
      )
    ).status,
    404,
  );

  // another academy
  const blueCoach = await app.as("blueCoach");
  assert.equal(
    (await save(blueCoach, s.id, snapshot.version, payload(USERS.blueCoach.id)))
      .status,
    404,
  );
  const blueOwner = await app.as("blueOwner");
  assert.equal(
    (await save(blueOwner, s.id, snapshot.version, payload(USERS.blueOwner.id)))
      .status,
    404,
  );
  assert.ok(!(await visibleIds(blueCoach)).includes(s.id));

  // roles that do not do coaching work
  for (const role of [
    "FINANCE",
    "NUTRITION_PRO",
    "GUARDIAN",
    "ADULT_PLAYER",
  ] as const) {
    const c = await app.as(ROLE_USER[role]);
    const r = await save(
      c,
      s.id,
      snapshot.version,
      payload(USERS[ROLE_USER[role]].id, { title: role }),
    );
    assert.ok([403, 404].includes(r.status), `${role} -> ${r.status}`);
    assert.ok(
      (await c.post("/api/training/sessions", {})).status >= 400,
      `${role} cannot start a draft`,
    );
  }
  // an anonymous caller
  assert.equal(
    (
      await app.anonymous().post(`/api/training/sessions/${s.id}`, {
        version: 1,
        action: "save",
        payload: payload("x"),
      })
    ).status,
    401,
  );

  const after = await row(s.id);
  assert.equal(after.version, snapshot.version);
  assert.equal(after.data.title, "Mine");
});

test("people who manage the academy can work on any draft of it (unchanged behaviour), still through the version check", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  for (const key of ["owner", "admin", "headCoach"] as const) {
    const manager = await app.as(key);
    assert.ok((await visibleIds(manager)).includes(s.id), `${key} sees it`);
  }
  const head = await app.as("headCoach");
  const v = (await row(s.id)).version;
  assert.equal(
    (
      await save(
        head,
        s.id,
        v,
        payload(USERS.coach.id, { title: "Head coach edit" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await save(
        head,
        s.id,
        v,
        payload(USERS.coach.id, { title: "Stale head coach edit" }),
      )
    ).status,
    409,
  );
});

test("only a draft can be saved: a recovered draft of a cancelled or deactivated session is refused", async () => {
  const coach = await app.as("coach");
  const s = await create(coach);
  assert.equal(
    (await save(coach, s.id, 1, { reason: "Court unavailable" }, "cancel"))
      .status,
    200,
  );
  const r = await save(
    coach,
    s.id,
    2,
    payload(USERS.coach.id, { title: "Too late" }),
  );
  assert.equal(r.status, 409);
  assert.match(err(r).error ?? "", /cannot save/i);
  assert.notEqual((await row(s.id)).data.title, "Too late");

  // a person whose access was switched off cannot save either, even with a valid version
  const t2 = await create(coach);
  // Stage 5D (migration 0011): a coach who still coaches a batch cannot be switched off, so the fixture
  // hands the batch to the head coach in the same transaction and gives it back afterwards.
  await db().transaction(async (tx) => {
    await tx
      .update(t.batches)
      .set({ coachId: USERS.headCoach.id })
      .where(and(eq(t.batches.academyId, "green"), eq(t.batches.coachId, USERS.coach.id)));
    await tx
      .update(t.memberships)
      .set({ active: false })
      .where(
        and(
          eq(t.memberships.userId, USERS.coach.id),
          eq(t.memberships.academyId, "green"),
        ),
      );
  });
  try {
    const r2 = await save(
      coach,
      t2.id,
      1,
      payload(USERS.coach.id, { title: "Deactivated" }),
    );
    assert.equal(r2.status, 403);
    assert.equal(err(r2).code, "MEMBERSHIP_INACTIVE");
    assert.equal((await row(t2.id)).version, 1);
  } finally {
    await db()
      .update(t.memberships)
      .set({ active: true })
      .where(
        and(
          eq(t.memberships.userId, USERS.coach.id),
          eq(t.memberships.academyId, "green"),
        ),
      );
    await db()
      .update(t.batches)
      .set({ coachId: USERS.coach.id })
      .where(and(eq(t.batches.academyId, "green"), eq(t.batches.id, "green-main")));
  }
});

test("existing training behaviour is intact: drills keep the order the person chose, minutes add up, and reordering is an ordinary edit", async () => {
  for (const data of sampleDrills.slice(0, 2))
    await db()
      .insert(t.drills)
      .values({ id: data.id, version: 1, academyId: null, data })
      .onConflictDoNothing();
  const coach = await app.as("coach");
  const boot = json<{
    drills: { id: string; version: number; title: string; minutes: number }[];
    batches: { id: string; branchId: string; coachId: string }[];
  }>(await coach.get("/api/training"));
  assert.ok(boot.drills.length >= 2, "the library has drills");
  const [d1, d2] = boot.drills;
  const s = await create(coach);
  const activities = [
    {
      id: "act-2",
      drillId: d2.id,
      drillVersion: d2.version,
      title: d2.title,
      minutes: 20,
      cues: "second",
    },
    {
      id: "act-1",
      drillId: d1.id,
      drillVersion: d1.version,
      title: d1.title,
      minutes: 25,
      cues: "first",
    },
  ];
  const r = await save(
    coach,
    s.id,
    1,
    payload(USERS.coach.id, { activities, duration: 45 }),
  );
  assert.equal(r.status, 200, r.text);
  const stored = (await row(s.id)).data;
  assert.deepEqual(
    stored.activities.map((a) => a.id),
    ["act-2", "act-1"],
    "order is the person's order",
  );
  assert.equal(
    stored.activities.reduce((n, a) => n + a.minutes, 0),
    stored.duration,
  );
  assert.equal(stored.activities[0].snapshot?.id, d2.id);
  // reordering and a changed duration are ordinary edits with the same version rule
  const re = await save(
    coach,
    s.id,
    2,
    payload(USERS.coach.id, {
      activities: [...activities].reverse(),
      duration: 45,
    }),
  );
  assert.equal(re.status, 200);
  assert.deepEqual(
    (await row(s.id)).data.activities.map((a) => a.id),
    ["act-1", "act-2"],
  );
});

test("every role gets the same answer for the training bootstrap as before this stage (coaching roles in, everyone else out)", async () => {
  const expected: Record<string, number> = {
    OWNER: 200,
    ADMIN: 200,
    HEAD_COACH: 200,
    COACH: 200,
    FINANCE: 403, // the finance and nutrition screens do not use the training service
    NUTRITION_PRO: 403,
    GUARDIAN: 403,
    ADULT_PLAYER: 403,
  };
  for (const role of ROLES) {
    const c = await app.as(ROLE_USER[role]);
    const r = await c.get("/api/training");
    assert.equal(r.status, expected[role], role);
  }
});
