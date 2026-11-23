import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { linkGuardian } from "../src/modules/players/application/service";
import { cancelDispatchBatch, dispatchBatchStatus, listDispatchBatches, previewDispatch, queueDispatch, retryFailedItems } from "../src/modules/dispatch/application/service";

process.env.BETTER_AUTH_SECRET = "isolated-dispatch-auth-test-secret-12345678901234";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * Who may do what with bulk delivery, role by role, and across academies. Preview needs the right to prepare messages (a coach
 * only for their own players); queueing, retrying and cancelling need the right to approve sending; the history and one batch's
 * detail name every family a batch reached, so they are for approvers only. A parent has none of it. Another academy's owner can
 * neither see nor touch this academy's batches, and a refused attempt changes nothing.
 */
let testDb: TestDatabase | undefined;
const actor = (id: string, role: string, academyId = "green"): Actor => ({ id, name: `Test ${id}`, role, academyId, timezone: "Asia/Kolkata", academyName: `Academy ${academyId}` });
const owner = actor("owner", "OWNER"),
  admin = actor("admin", "ADMIN"),
  head = actor("head", "HEAD_COACH"),
  coach = actor("coach", "COACH"),
  coach2 = actor("coach2", "COACH"),
  finance = actor("finance", "FINANCE"),
  pro = actor("pro", "NUTRITION_PRO"),
  parent = actor("parent-a", "GUARDIAN"),
  blueOwner = actor("blue-owner", "OWNER", "blue");
const reportData = (id: string, name: string) =>
  ({ playerId: id, periodStart: "2027-03-01", periodEnd: "2027-03-31", title: "March report", summary: "s", strengths: "", improvements: "", priorities: [], closingNote: "", evidence: [], academyName: "Academy green", playerName: name, reviewer: null, approvedAt: null }) as never;

before(async () => {
  testDb = await provisionTestDatabase("dispatch-auth");
  const db = database();
  for (const id of ["green", "blue"]) {
    await db.insert(t.academies).values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
    await db.insert(t.academySettings).values({ academyId: id, data: defaultSettings });
    await db.insert(t.entitlements).values({ academyId: id, data: { reports: true, nutrition: true, communications: true, manualVideo: true } });
    await db.insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Test branch" });
  }
  for (const a of [owner, admin, head, coach, coach2, finance, pro, parent, blueOwner]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: a.academyId, userId: a.id, role: a.role });
  }
  await db.insert(t.batches).values({ id: "batch-1", academyId: "green", coachId: "coach", branchId: "green-branch", name: "Under 13" });
  await db.insert(t.batches).values({ id: "batch-2", academyId: "green", coachId: "coach2", branchId: "green-branch", name: "Under 15" });
  for (const [id, name, batchId] of [["A", "Aadi Sharma", "batch-1"], ["C", "Chitra Das", "batch-2"]] as const) {
    await db.insert(t.players).values({ id, academyId: "green", batchId, name });
    await db.insert(t.profiles).values({ academyId: "green", playerId: id, data: { ...defaultProfile, status: "ACTIVE" } });
    await db.insert(t.reports).values({ id: `rep-${id}`, academyId: "green", playerId: id, status: "PUBLISHED", version: 2, data: reportData(id, name) });
  }
  // Parent of A (the account used as the "GUARDIAN" actor) and the parent of C (a different family, coached by the OTHER coach).
  await db.insert(t.user).values({ id: "parent-c", name: "Sunita Das", email: "sunita@example.test" });
  await db.insert(t.memberships).values({ academyId: "green", userId: "parent-c", role: "GUARDIAN" });
  await linkGuardian(owner, { playerId: "A", userId: parent.id, relationship: "Parent", active: true });
  await linkGuardian(owner, { playerId: "C", userId: "parent-c", relationship: "Parent", active: true });
});
after(async () => {
  await testDb?.cleanup();
});

const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e as { status?: number }).status ?? 500);
const sel = (ids: string[]) => ({ reportIds: ids, mode: "PARENTS", channels: ["EMAIL"], consolidation: "PER_PARENT" });
const rows = async () => (await database().select().from(t.dispatchItems)).map((i) => `${i.id}:${i.status}:${i.attempts}`).sort().join("|");
const batchStates = async () => (await database().select().from(t.dispatchBatches)).map((b) => `${b.id}:${b.status}`).sort().join("|");
let batchId = "";

test("preview: those who prepare messages may (a coach for their own players only); finance, the nutrition professional and a parent may not; another academy finds nothing", async () => {
  for (const a of [owner, admin, head, coach]) assert.equal(await status(previewDispatch(a, sel(["rep-A"]))), 200, `${a.role} previews their own`);
  for (const a of [finance, pro, parent]) assert.equal(await status(previewDispatch(a, sel(["rep-A"]))), 403, `${a.role} may not preview`);
  assert.equal(await status(previewDispatch(blueOwner, sel(["rep-A"]))), 404, "another academy's reports are not found");
  // A coach asking about a player of the OTHER coach learns nothing about that family.
  const attempt = await previewDispatch(coach, sel(["rep-A", "rep-C"])).then(
    (r) => JSON.stringify(r),
    (e: unknown) => `refused ${(e as { status?: number }).status}`,
  );
  assert.ok(!/Sunita|Chitra|sunita@/i.test(attempt), `the other coach's family is not disclosed (${attempt.slice(0, 80)})`);
});

test("queueing sending needs the right to approve: owner, administrator and head coach; nobody else, and a refusal changes nothing", async () => {
  const before = await rows();
  for (const a of [coach, coach2, finance, pro, parent, blueOwner]) {
    const s = await status(queueDispatch(a, sel(["rep-A", "rep-C"])));
    assert.ok(s === 403 || s === 404, `${a.role}/${a.academyId} refused (got ${s})`);
  }
  assert.equal(await rows(), before, "nothing was queued by the refused attempts");
  const q = await queueDispatch(owner, { ...sel(["rep-A", "rep-C"]), title: "March" });
  assert.ok(q.queued > 0);
  batchId = q.batchId;
  // Administrator and head coach are approvers too: they are not refused (the same selection now has nothing left to queue).
  for (const a of [admin, head]) assert.notEqual(await status(queueDispatch(a, sel(["rep-A", "rep-C"]))), 403, `${a.role} may approve sending`);
});

test("history and one batch's detail name every family it reached, so they are for approvers: a coach sees none, a parent and other academies are refused", async () => {
  for (const a of [owner, admin, head]) {
    const list = await listDispatchBatches(a);
    assert.equal(list.batches.length, 1, `${a.role} sees the history`);
    const detail = await dispatchBatchStatus(a, { batchId });
    assert.equal(detail.items.length, 2);
  }
  const coachList = await listDispatchBatches(coach);
  assert.deepEqual(coachList.batches, [], "a coach may prepare messages but sees no delivery history");
  assert.ok(coachList.channels, "channel states are still shown so the preview makes sense");
  const detail = await status(dispatchBatchStatus(coach, { batchId }));
  assert.equal(detail, 403, "a coach cannot open a batch that reached other coaches' families");
  for (const a of [finance, pro, parent]) {
    assert.equal(await status(listDispatchBatches(a)), 403, `${a.role} has no history`);
    assert.equal(await status(dispatchBatchStatus(a, { batchId })), 403);
  }
  assert.equal((await listDispatchBatches(blueOwner)).batches.length, 0, "another academy's history is empty");
  assert.equal(await status(dispatchBatchStatus(blueOwner, { batchId })), 404, "another academy's batch answers like an unknown id");
});

test("retry and cancel need the right to approve; other academies and parents are refused and nothing moves; an approver can do both", async () => {
  const items = await rows();
  const batches = await batchStates();
  for (const a of [coach, coach2, finance, pro, parent]) {
    assert.equal(await status(retryFailedItems(a, { batchId })), 403, `${a.role} may not retry`);
    assert.equal(await status(cancelDispatchBatch(a, { batchId })), 403, `${a.role} may not cancel`);
  }
  assert.equal(await status(retryFailedItems(blueOwner, { batchId })), 404);
  assert.equal(await status(cancelDispatchBatch(blueOwner, { batchId })), 404);
  assert.equal(await status(retryFailedItems(owner, { batchId: crypto.randomUUID() })), 404, "an unknown id is a plain not-found");
  assert.equal(await rows(), items, "the refused attempts changed no message");
  assert.equal(await batchStates(), batches, "and no batch");
  assert.equal(await status(retryFailedItems(admin, { batchId })), 200, "an administrator may retry");
  const stopped = await cancelDispatchBatch(head, { batchId });
  assert.ok(stopped.stopped > 0, "a head coach may cancel");
  const audits = await database().select().from(t.audit).where(eq(t.audit.academyId, "green"));
  assert.ok(audits.some((x) => x.action === "dispatch-cancel" && x.actorId === head.id), "the cancellation is attributed to the person who did it");
  assert.ok(audits.some((x) => x.action === "dispatch-retry" && x.actorId === admin.id));
});
