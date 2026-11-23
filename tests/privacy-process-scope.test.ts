import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { processDueErasures } from "../src/modules/privacy/application/process";
import { SUBJECT_IDS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";

/**
 * F-01: "Run due erasures now" must act on the CALLER's academy only, and must tell the caller nothing about any other
 * academy's requests. The operator command (npm run privacy:process) is the global form and stays global.
 * Requests are inserted already approved and past their grace period with an empty plan, so processing one changes
 * nothing about any player; what is under test is WHICH requests a call touches and reports.
 */
let app: Harness;
let dir: string;
before(
  async () => {
    dir = mkdtempSync(join(tmpdir(), "f01-"));
    process.env.ERASURE_LEDGER_PATH = join(dir, "ledger.jsonl");
    app = await startHarness("privacy-process-scope");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    delete process.env.ERASURE_LEDGER_PATH;
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  },
  { timeout: HOOK_TIMEOUT },
);

const db = () => database();
// A request that was left waiting by the previous test would collide with the next one for the same player
// (one open request per player), so every test starts with none open.
beforeEach(async () => {
  await db().update(t.erasureRequests).set({ status: "CANCELLED" }).where(eq(t.erasureRequests.status, "GRACE_PERIOD"));
});
const PROCESS = "/api/academy/privacy/process";
type Outcome = { id: string; status: string; note?: string };
const row = async (id: string) => (await db().select().from(t.erasureRequests).where(eq(t.erasureRequests.id, id)))[0];
const eventsOf = async (id: string) => db().select().from(t.erasureEvents).where(eq(t.erasureEvents.requestId, id));

/** An approved request whose grace period has ended: due for processing right now. */
async function dueRequest(academyId: "green" | "blue", playerId: string) {
  const id = `f01-${academyId}-${crypto.randomUUID()}`;
  await db().insert(t.erasureRequests).values({
    id,
    academyId,
    playerId,
    source: "ADMIN",
    reason: "F-01 regression: a request that is due.",
    requestedBy: "f01-test",
    status: "GRACE_PERIOD",
    executeAfter: new Date(Date.now() - 60_000),
    plan: [],
    steps: [],
  });
  return id;
}
const untouched = async (id: string) => {
  const r = await row(id);
  assert.equal(r.status, "GRACE_PERIOD", `${id} stays waiting`);
  assert.equal(r.attempts, 0, `${id} was never claimed`);
  assert.equal((await eventsOf(id)).length, 0, `${id} has no new history`);
};

test("an Owner who runs privacy processing touches and sees only their own academy's due requests", async () => {
  const mine = await dueRequest("green", SUBJECT_IDS.childA);
  const theirs = await dueRequest("blue", SUBJECT_IDS.blue);
  const owner = await app.as("owner");
  const r = await owner.post(PROCESS, {});
  assert.equal(r.status, 200, r.text);
  const processed = (r.json as { processed: Outcome[] }).processed;
  assert.ok(processed.some((o) => o.id === mine), "their own due request was processed");
  assert.ok(processed.every((o) => o.id !== theirs), "the other academy's request is not in the answer");
  assert.ok(!r.text.includes(theirs), "nothing about the other academy's request leaves the server");
  await untouched(theirs);
  assert.notEqual((await row(mine)).status, "GRACE_PERIOD", "their own request really ran");
});

test("and the same holds the other way round", async () => {
  const green = await dueRequest("green", SUBJECT_IDS.childB);
  const blue = await dueRequest("blue", SUBJECT_IDS.blue);
  const blueOwner = await app.as("blueOwner");
  const r = await blueOwner.post(PROCESS, {});
  assert.equal(r.status, 200, r.text);
  const processed = (r.json as { processed: Outcome[] }).processed;
  assert.ok(processed.some((o) => o.id === blue));
  assert.ok(processed.every((o) => o.id !== green));
  assert.ok(!r.text.includes(green));
  await untouched(green);
});

test("the service takes its scope from the academy it is given; the operator form without one stays global", async () => {
  const green = await dueRequest("green", SUBJECT_IDS.childA);
  const blue = await dueRequest("blue", SUBJECT_IDS.blue);
  const scoped = await processDueErasures({ academyId: "blue" });
  assert.ok(scoped.some((o) => o.id === blue) && scoped.every((o) => o.id !== green));
  await untouched(green);
  const blueAgain = await dueRequest("blue", SUBJECT_IDS.blue);
  const operator = await processDueErasures({ limit: 50 });
  const ids = operator.map((o) => o.id);
  assert.ok(ids.includes(green) && ids.includes(blueAgain), "the operator command processes every academy");
});

test("an academy with nothing due gets an empty answer, not somebody else's", async () => {
  await dueRequest("green", SUBJECT_IDS.childB);
  const blueOwner = await app.as("blueOwner");
  const r = await blueOwner.post(PROCESS, {});
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((r.json as { processed: Outcome[] }).processed, []);
});
