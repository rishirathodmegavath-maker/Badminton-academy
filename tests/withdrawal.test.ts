import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import { withdrawReport } from "../src/modules/reports/application/service";
import { pdfRenderer, reportPdf } from "../src/modules/reports/application/pdf";
import { withdrawNutritionPlan } from "../src/modules/nutrition/application/service";
import {
  publicationState,
  validWithdrawalReason,
} from "../src/modules/academy/domain/withdrawal";
import { CANARY, FIXTURE_PASSWORD, ROLES, ROLE_USER, USERS, addFixtureUser, idsFor, type FixtureUserKey, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, signedIn } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";
/**
 * Phase 6: withdrawing published reports and nutrition plans.
 * Real HTTP over the real route handlers (plus direct service calls where the point is that the
 * service itself refuses). Every test creates its own records so tests cannot disturb each other.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("withdrawal");
  },
  { timeout: HOOK_TIMEOUT },
);
after(async () => app.stop(), { timeout: HOOK_TIMEOUT });
const A = idsFor("childA");
const B = idsFor("childB");
const BL = idsFor("blue");
const API = "/api/academy";
const REASON = "Parent reported the wrong child was named in the second paragraph.";
const as = (key: FixtureUserKey) => app.as(key);
const call = async (client: TestClient, route: string, body: unknown) => client.post(`${API}/${route}`, body);
type Row = { id: string; version: number; status: string };
let counter = 0;
const academyActor = (role: string, id: string, academyId = "green"): Actor => ({ id, name: "x", academyId, role, timezone: "UTC", academyName: "x" });
const reportData = (playerId: string, name: string, summary: string) => ({
  playerId,
  periodStart: "2027-02-01",
  periodEnd: "2027-02-28",
  title: "Phase 6 report",
  summary,
  evidence: [],
  academyName: "Fixture green Academy",
  playerName: name,
  reviewer: null,
  approvedAt: null,
});
/** A fresh DRAFT report (row + its first revision), shaped exactly as the services persist it. */
async function seedReport(playerId = A.playerId, name = CANARY.childA.name, academyId = "green") {
  const id = `wd-report-${++counter}-end`;
  const data = reportData(playerId, name, `WD-SUMMARY-${id}`);
  await database().insert(t.reports).values({ id, academyId, playerId, version: 1, status: "DRAFT", data });
  await database().insert(t.recordRevisions).values({ id: `rev-${id}-1`, academyId, entityId: id, kind: "report", version: 1, data: { status: "DRAFT", data, reason: "" } });
  return id;
}
const reportRow = async (id: string) => (await database().select().from(t.reports).where(eq(t.reports.id, id)))[0];
const revisions = async (id: string, kind = "report") =>
  (await database().select().from(t.recordRevisions).where(and(eq(t.recordRevisions.entityId, id), eq(t.recordRevisions.kind, kind)))).sort((a, b) => a.version - b.version);
async function advanceReport(id: string, ...actions: string[]) {
  const owner = await as("owner");
  let row = await reportRow(id);
  for (const action of actions) {
    const r = await call(owner, "reports/update", { id, version: row.version, action, summary: "", reason: action === "revise" ? "Correcting the second paragraph." : "" });
    assert.equal(r.status, 200, `${action}: ${r.text.slice(0, 160)}`);
    row = await reportRow(id);
  }
  return row;
}
const publishReport = (id: string) => advanceReport(id, "submit", "approve", "publish");
const withdrawR = async (client: TestClient, id: string, extra: Record<string, unknown> = {}) =>
  call(client, "reports/withdraw", { id, version: (await reportRow(id)).version, reason: REASON, ...extra });
const nutritionData = (playerId: string, summary: string) => ({ playerId, title: "Phase 6 plan", guidance: `WD-GUIDANCE-${summary}`, professional: null, reviewNote: "", approvedAt: null });
async function seedPlan(playerId = A.playerId, academyId = "green") {
  const id = `wd-plan-${++counter}-end`;
  const data = nutritionData(playerId, id);
  await database().insert(t.nutritionPlans).values({ id, academyId, playerId, version: 1, status: "DRAFT", data });
  await database().insert(t.recordRevisions).values({ id: `rev-${id}-1`, academyId, entityId: id, kind: "nutrition-plan", version: 1, data: { status: "DRAFT", data } });
  return id;
}
const planRow = async (id: string) => (await database().select().from(t.nutritionPlans).where(eq(t.nutritionPlans.id, id)))[0];
async function advancePlan(id: string, ...actions: string[]) {
  const pro = await as("nutrition");
  const owner = await as("owner");
  let row = await planRow(id);
  for (const action of actions) {
    const client = action === "approve" || action === "share" ? pro : owner;
    const r = await call(client, "nutrition/plan", { id, version: row.version, playerId: row.playerId, title: "Phase 6 plan", guidance: "Reviewed guidance text", action, reviewNote: action === "approve" ? "Reviewed and approved by me." : "" });
    assert.equal(r.status, 200, `${action}: ${r.text.slice(0, 160)}`);
    row = await planRow(id);
  }
  return row;
}
const sharePlan = (id: string) => advancePlan(id, "submit", "approve", "share");
const withdrawN = async (client: TestClient, id: string, extra: Record<string, unknown> = {}) =>
  call(client, "nutrition/withdraw", { id, version: (await planRow(id)).version, reason: REASON, ...extra });
const bootstrap = async (client: TestClient) => (await client.get(API)).json as { reports: Row[]; nutrition: Row[]; versions: { entityId: string; kind: string; version: number; data: Record<string, unknown> }[] };
const familyReportIds = async (key: FixtureUserKey = "guardian") => (await bootstrap(await as(key))).reports.map((r) => r.id);
const familyPlanIds = async (key: FixtureUserKey = "guardian") => (await bootstrap(await as(key))).nutrition.map((r) => r.id);
const pdfStatus = async (key: FixtureUserKey, id: string) => (await (await as(key)).get(`${API}/reports/${id}/pdf`)).status;
const eventCount = async (event: string) => (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, event))).length;
const withdrawalEvents = async () => (await eventCount("REPORT_WITHDRAWN")) + (await eventCount("NUTRITION_PLAN_WITHDRAWN"));
const auditCount = async (action: string) => (await database().select().from(t.audit).where(eq(t.audit.action, action))).length;
test("pure rules: the newest published revision is live unless a withdrawal came after it; reasons must be words", () => {
  const rev = (version: number, status: string, withdrawal?: object) => ({ kind: "report", version, data: { status, ...(withdrawal ? { withdrawal } : {}) } });
  const mark = { contentType: "report", withdrawnVersion: 2, actorId: "u", actorRole: "OWNER", at: "x", reason: "y" };
  assert.equal(publicationState([rev(1, "DRAFT")], "report").live, null);
  assert.equal(publicationState([rev(1, "DRAFT"), rev(2, "PUBLISHED"), rev(3, "DRAFT")], "report").live?.version, 2, "a revision in progress leaves the published one live");
  assert.deepEqual(publicationState([rev(3, "DRAFT"), rev(1, "PUBLISHED"), rev(2, "PUBLISHED")], "report").live?.version, 2, "input order does not matter");
  const withdrawn = publicationState([rev(1, "DRAFT"), rev(2, "PUBLISHED"), rev(3, "DRAFT", mark)], "report");
  assert.deepEqual([withdrawn.live, withdrawn.withdrawn], [null, true]);
  assert.equal(publicationState([rev(2, "PUBLISHED"), rev(3, "DRAFT", mark), rev(4, "DRAFT"), rev(5, "PUBLISHED")], "report").live?.version, 5, "publishing again after a withdrawal is a new decision");
  assert.equal(publicationState([rev(2, "PUBLISHED"), rev(3, "DRAFT", mark), rev(4, "DRAFT")], "report").live, null, "revising does not undo a withdrawal");
  assert.equal(publicationState([rev(2, "SHARED")], "report").live, null, "a shared status means nothing for a report");
  assert.equal(publicationState([{ kind: "nutrition-plan", version: 1, data: { status: "SHARED" } }], "nutrition-plan").live?.version, 1);
  assert.equal(publicationState([{ kind: "nutrition-plan", version: 1, data: { status: "SHARED" } }], "report").live, null, "kinds do not mix");
  for (const bad of ["", "   ", "short", "because because", "a b c d e f g h", "x".repeat(40), "oops oops oops oops"])
    assert.equal(validWithdrawalReason(bad), false, JSON.stringify(bad));
  assert.equal(validWithdrawalReason(REASON), true);
  assert.equal(validWithdrawalReason(`${REASON} ${"more words ".repeat(60)}`), false, "bounded");
});
test("report lifecycle: publish, REVISE leaves the published revision with families, WITHDRAW removes it, history is kept", async () => {
  const id = await seedReport();
  const family = await as("guardian");
  const owner = await as("owner");
  assert.ok(!(await familyReportIds()).includes(id), "a draft is not family-visible");
  const published = await publishReport(id);
  assert.equal(published.status, "PUBLISHED");
  assert.ok((await familyReportIds()).includes(id));
  assert.equal(await pdfStatus("guardian", id), 200);
  // REVISE: the working copy returns to DRAFT; families keep the published revision.
  const eventsBeforeRevise = await withdrawalEvents();
  const revised = await advanceReport(id, "revise");
  assert.equal(revised.status, "DRAFT");
  assert.ok((await familyReportIds()).includes(id), "revising does not withdraw");
  const seen = (await bootstrap(family)).reports.find((r) => r.id === id)!;
  assert.deepEqual([seen.status, seen.version], ["PUBLISHED", published.version], "families still see the published revision, not the draft");
  assert.equal(await pdfStatus("guardian", id), 200);
  assert.equal(await withdrawalEvents(), eventsBeforeRevise, "no withdrawal event for a revision");
  assert.equal((await revisions(id)).some((r) => (r.data as { withdrawal?: unknown }).withdrawal), false);
  // WITHDRAW while the revision is still being prepared.
  const before = await revisions(id);
  const w = await withdrawR(owner, id);
  assert.equal(w.status, 200, w.text);
  const after = await reportRow(id);
  assert.deepEqual([after.status, after.version], ["DRAFT", revised.version + 1], "the draft in progress is untouched; the record version moves on");
  assert.ok(!(await familyReportIds()).includes(id), "families no longer see it");
  assert.equal(await pdfStatus("guardian", id), 404);
  // The history keeps every earlier revision byte for byte and adds one marker.
  const history = await revisions(id);
  assert.equal(history.length, before.length + 1);
  assert.deepEqual(history.slice(0, before.length), before, "earlier revisions are not edited");
  assert.ok((history.at(-1)!.data as { withdrawal?: { withdrawnVersion: number } }).withdrawal?.withdrawnVersion === published.version);
  // Staff keep access to the record, the PDF and the history.
  const staffView = await bootstrap(owner);
  assert.ok(staffView.reports.some((r) => r.id === id));
  assert.ok(staffView.versions.filter((v) => v.entityId === id).length === history.length);
  assert.equal(await pdfStatus("owner", id), 200);
  assert.equal(await pdfStatus("coach", id), 200);
  // Revising after a withdrawal still does not bring it back; publishing again is a new, deliberate decision.
  await advanceReport(id, "submit", "approve");
  assert.ok(!(await familyReportIds()).includes(id), "approval alone does not republish");
  assert.equal(await pdfStatus("guardian", id), 404);
  const again = await advanceReport(id, "publish");
  assert.equal(again.status, "PUBLISHED");
  assert.ok((await familyReportIds()).includes(id), "published again, visible again");
  assert.equal(await pdfStatus("guardian", id), 200);
});
test("report withdrawn straight from PUBLISHED becomes WITHDRAWN, can be revised from there, and duplicates are refused", async () => {
  const id = await seedReport();
  const owner = await as("owner");
  const published = await publishReport(id);
  const before = await withdrawalEvents();
  const w = await withdrawR(owner, id);
  assert.equal(w.status, 200, w.text);
  assert.equal((w.json as Row).status, "WITHDRAWN");
  assert.equal((w.json as Row).version, published.version + 1);
  assert.equal(await withdrawalEvents(), before + 1);
  // Duplicate (current version) and stale duplicate (old version): refused, nothing recorded.
  const dup = await withdrawR(owner, id);
  assert.equal(dup.status, 409);
  assert.equal(code(dup), "ALREADY_WITHDRAWN");
  const stale = await call(owner, "reports/withdraw", { id, version: published.version, reason: REASON });
  assert.equal(stale.status, 409);
  assert.equal(await withdrawalEvents(), before + 1, "refused repeats write no event");
  assert.equal((await revisions(id)).length, published.version + 1, "and no revision");
  // Invalid transitions around a withdrawal.
  const update = async (action: string) => call(owner, "reports/update", { id, version: (await reportRow(id)).version, action, summary: "x", reason: "" });
  for (const action of ["save", "submit", "approve", "publish"]) assert.equal((await update(action)).status, 422, action);
  // A never-published record has nothing to withdraw.
  const draft = await seedReport();
  const none = await withdrawR(owner, draft);
  assert.equal(none.status, 409);
  assert.equal(code(none), "NOT_PUBLISHED");
  // WITHDRAWN -> revise -> DRAFT, still hidden from families.
  const revise = await call(owner, "reports/update", { id, version: (await reportRow(id)).version, action: "revise", summary: "", reason: "Fix and reissue." });
  assert.equal(revise.status, 200, revise.text);
  assert.equal((revise.json as Row).status, "DRAFT");
  assert.ok(!(await familyReportIds()).includes(id));
  assert.equal(code(await withdrawR(owner, id)), "ALREADY_WITHDRAWN", "revising does not make it withdrawable again");
});
test("nutrition lifecycle: share, REVISE keeps the shared plan with families, WITHDRAW removes it, history is kept", async () => {
  const id = await seedPlan();
  const pro = await as("nutrition");
  assert.ok(!(await familyPlanIds()).includes(id));
  const shared = await sharePlan(id);
  assert.equal(shared.status, "SHARED");
  assert.ok((await familyPlanIds()).includes(id));
  const eventsBefore = await withdrawalEvents();
  const revised = await advancePlan(id, "revise");
  assert.equal(revised.status, "DRAFT");
  const seen = (await bootstrap(await as("guardian"))).nutrition.find((n) => n.id === id)!;
  assert.deepEqual([seen.status, seen.version], ["SHARED", shared.version], "families still see the shared revision");
  assert.equal(await withdrawalEvents(), eventsBefore, "revision is not withdrawal");
  const before = await revisions(id, "nutrition-plan");
  const w = await withdrawN(pro, id);
  assert.equal(w.status, 200, w.text);
  assert.ok(!(await familyPlanIds()).includes(id));
  const history = await revisions(id, "nutrition-plan");
  assert.equal(history.length, before.length + 1);
  assert.deepEqual(history.slice(0, before.length), before);
  const staffPlans = (await bootstrap(pro)).nutrition.map((n) => n.id);
  assert.ok(staffPlans.includes(id), "the professional keeps the record");
  assert.ok((await bootstrap(pro)).versions.some((v) => v.entityId === id && (v.data as { withdrawal?: unknown }).withdrawal), "and its history, including the withdrawal");
  assert.equal(code(await withdrawN(pro, id)), "ALREADY_WITHDRAWN");
  // Re-sharing after approval is a new decision.
  await advancePlan(id, "submit", "approve");
  assert.ok(!(await familyPlanIds()).includes(id));
  await advancePlan(id, "share");
  assert.ok((await familyPlanIds()).includes(id));
  // Withdrawn straight from SHARED -> WITHDRAWN -> revisable.
  const second = await seedPlan();
  await sharePlan(second);
  const w2 = await withdrawN(await as("owner"), second);
  assert.equal((w2.json as Row).status, "WITHDRAWN");
  assert.equal((await advancePlan(second, "revise")).status, "DRAFT");
  assert.ok(!(await familyPlanIds()).includes(second));
  const never = await seedPlan();
  assert.equal(code(await withdrawN(pro, never)), "NOT_PUBLISHED");
});
test("records that existed before Phase 6 (published once, later revised) can be withdrawn too; no migration or backfill is needed", async () => {
  // Fixture shape: row DRAFT v3 with revisions DRAFT, PUBLISHED, DRAFT (a revised report).
  const owner = await as("owner");
  assert.ok((await familyReportIds("guardian2")).includes(B.reportId), "visible through its published revision");
  const w = await call(owner, "reports/withdraw", { id: B.reportId, version: 3, reason: REASON });
  assert.equal(w.status, 200, w.text);
  assert.ok(!(await familyReportIds("guardian2")).includes(B.reportId));
  assert.equal(await pdfStatus("guardian2", B.reportId), 404);
  // Fixture nutrition: a plan shared long ago with a single SHARED revision (row version 1).
  assert.ok((await familyPlanIds("guardian2")).includes(B.nutritionPlanId));
  const wn = await call(await as("nutrition2"), "nutrition/withdraw", { id: B.nutritionPlanId, version: 1, reason: REASON });
  assert.equal(wn.status, 200, wn.text);
  assert.ok(!(await familyPlanIds("guardian2")).includes(B.nutritionPlanId));
  // Nothing else of the other family was touched.
  assert.ok((await familyReportIds("guardian")).includes(A.reportId));
  assert.ok((await familyPlanIds("guardian")).includes(A.nutritionPlanId));
});
test("who may withdraw a report: owner, admin and head coach only; nobody else, no other academy, no anonymous caller", async () => {
  const owner = await as("owner");
  const allowed: Role[] = ["OWNER", "ADMIN", "HEAD_COACH"];
  for (const role of ROLES) {
    const id = await seedReport();
    await publishReport(id);
    const client = await as(ROLE_USER[role]);
    const before = await withdrawalEvents();
    const r = await withdrawR(client, id);
    if (allowed.includes(role)) {
      assert.equal(r.status, 200, `${role}: ${r.text}`);
      assert.equal(await withdrawalEvents(), before + 1, role);
      assert.ok(!(await familyReportIds()).includes(id), role);
    } else {
      assert.equal(r.status, 403, role);
      assert.equal((await reportRow(id)).status, "PUBLISHED", `${role} changed nothing`);
      assert.equal(await withdrawalEvents(), before, `${role}: no event`);
      assert.ok((await familyReportIds()).includes(id), role);
    }
  }
  const id = await seedReport();
  await publishReport(id);
  // Another academy's owner and guardian cannot reach this academy's record by id.
  for (const key of ["blueOwner", "quietOwner"] as const) {
    const r = await withdrawR(await as(key), id);
    assert.equal(r.status, 404, key);
  }
  assert.equal((await withdrawR(await as("blueGuardian"), id)).status, 403);
  // A record that is not in this academy at all looks the same as one that does not exist.
  const blueReport = await call(owner, "reports/withdraw", { id: BL.reportId, version: 3, reason: REASON });
  assert.equal(blueReport.status, 404);
  assert.equal((await call(owner, "reports/withdraw", { id: "no-such-report", version: 1, reason: REASON })).status, 404);
  assert.equal((await app.anonymous().post(`${API}/reports/withdraw`, { id, version: 2, reason: REASON })).status, 401);
  assert.equal((await owner.post(`${API}/reports/withdraw`, { id, version: 2, reason: REASON }, { origin: "https://evil.example" })).status, 403, "cross-site request refused");
  assert.equal((await reportRow(id)).status, "PUBLISHED");
  assert.equal((await reportRow(BL.reportId)).status, "DRAFT");
});
test("report authority also follows player access and active membership; the service refuses on its own", async () => {
  const id = await seedReport();
  await publishReport(id);
  const row = await reportRow(id);
  // Direct service calls (not through the route).
  await assert.rejects(() => withdrawReport(academyActor("COACH", USERS.coach.id), { id, version: row.version, reason: REASON }), (e: unknown) => e instanceof DomainError && e.status === 403);
  await assert.rejects(() => withdrawReport(academyActor("GUARDIAN", USERS.guardian.id), { id, version: row.version, reason: REASON }), (e: unknown) => e instanceof DomainError && e.status === 403);
  await assert.rejects(() => withdrawReport(academyActor("OWNER", USERS.blueOwner.id, "blue"), { id, version: row.version, reason: REASON }), (e: unknown) => e instanceof DomainError && e.status === 404);
  await assert.rejects(() => withdrawReport(academyActor("OWNER", USERS.owner.id), { id, version: row.version, reason: "no" }), (e: unknown) => e instanceof DomainError && e.code === "WITHDRAWAL_REASON_REQUIRED");
  assert.equal((await reportRow(id)).status, "PUBLISHED");
  // A deactivated membership keeps nothing: the session stops working at once.
  const { id: adminId, email } = await addFixtureUser("wd-admin", [{ academyId: "green", role: "ADMIN" }]);
  const client = await signedIn(app, email, FIXTURE_PASSWORD);
  await database().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, adminId));
  const refused = await withdrawR(client, id);
  assert.ok([401, 403].includes(refused.status), `status ${refused.status}`);
  assert.equal((await reportRow(id)).status, "PUBLISHED");
  assert.ok((await familyReportIds()).includes(id));
});
test("who may withdraw a nutrition plan: owner, admin, head coach and the ASSIGNED professional; nobody else", async () => {
  const allowed: Role[] = ["OWNER", "ADMIN", "HEAD_COACH", "NUTRITION_PRO"];
  for (const role of ROLES) {
    const id = await seedPlan();
    await sharePlan(id);
    const before = await withdrawalEvents();
    const r = await withdrawN(await as(ROLE_USER[role]), id);
    if (allowed.includes(role)) {
      assert.equal(r.status, 200, `${role}: ${r.text}`);
      assert.ok(!(await familyPlanIds()).includes(id), role);
      assert.equal(await withdrawalEvents(), before + 1, role);
    } else {
      assert.equal(r.status, 403, role);
      assert.equal((await planRow(id)).status, "SHARED", role);
      assert.equal(await withdrawalEvents(), before, role);
    }
  }
  const id = await seedPlan();
  await sharePlan(id);
  // A professional with no ACTIVE assignment to this child sees nothing: same answer as a missing plan.
  assert.equal((await withdrawN(await as("nutrition2"), id)).status, 404, "assigned to the other child only");
  const bravo = await seedPlan(B.playerId, "green");
  assert.equal((await withdrawN(await as("nutrition"), bravo)).status, 404, "withdrawn assignment grants nothing");
  for (const key of ["blueOwner", "blueNutrition", "quietOwner"] as const) assert.equal((await withdrawN(await as(key), id)).status, 404, key);
  assert.equal((await call(await as("owner"), "nutrition/withdraw", { id: BL.nutritionPlanId, version: 1, reason: REASON })).status, 404);
  assert.equal((await app.anonymous().post(`${API}/nutrition/withdraw`, { id, version: 2, reason: REASON })).status, 401);
  assert.equal((await planRow(id)).status, "SHARED");
  const row = await planRow(id);
  await assert.rejects(() => withdrawNutritionPlan(academyActor("GUARDIAN", USERS.guardian.id), { id, version: row.version, reason: REASON }), (e: unknown) => e instanceof DomainError && e.status === 403);
  await assert.rejects(() => withdrawNutritionPlan(academyActor("NUTRITION_PRO", USERS.nutrition2.id), { id, version: row.version, reason: REASON }), (e: unknown) => e instanceof DomainError && e.status === 404);
  // Ending the assignment ends the professional's right to withdraw.
  await database().update(t.nutritionAssignments).set({ active: false }).where(and(eq(t.nutritionAssignments.playerId, A.playerId), eq(t.nutritionAssignments.professionalId, USERS.nutrition.id)));
  assert.equal((await withdrawN(await as("nutrition"), id)).status, 404);
  await database().update(t.nutritionAssignments).set({ active: true }).where(and(eq(t.nutritionAssignments.playerId, A.playerId), eq(t.nutritionAssignments.professionalId, USERS.nutrition.id)));
});
test("families: other families, other academies and ids guessed directly never see withdrawn content", async () => {
  const id = await seedReport();
  await publishReport(id);
  const plan = await seedPlan();
  await sharePlan(plan);
  assert.equal(await pdfStatus("guardian2", id), 404, "another family never could");
  assert.equal(await pdfStatus("blueGuardian", id), 404);
  assert.equal(await pdfStatus("adult", id), 404);
  await withdrawR(await as("owner"), id);
  await withdrawN(await as("owner"), plan);
  for (const key of ["guardian", "guardian2", "adult", "blueGuardian"] as const) {
    assert.ok(!(await familyReportIds(key)).includes(id), key);
    assert.ok(!(await familyPlanIds(key)).includes(plan), key);
    assert.equal(await pdfStatus(key, id), 404, key);
  }
  // Nothing about it in anything a family receives, however the payload is searched.
  const everything = JSON.stringify((await (await as("guardian")).get(API)).json);
  assert.ok(!everything.includes(id) && !everything.includes(plan) && !everything.includes(`WD-SUMMARY-${id}`) && !everything.includes(`WD-GUIDANCE-${plan}`) && !everything.includes(REASON));
  // Coaches and finance: the usual staff boundaries still apply (finance never had reports).
  assert.ok([403, 404].includes(await pdfStatus("finance", id)));
  // A new session or a fresh sign-in sees the same (no stale state).
  const fresh = await signedIn(app, USERS.guardian.email, FIXTURE_PASSWORD);
  assert.ok(!(await bootstrap(fresh)).reports.some((r) => r.id === id));
});
test("audit: a real reason is mandatory; the record, history, audit row and security event say who, what and when - without content", async () => {
  const id = await seedReport();
  await publishReport(id);
  const owner = await as("owner");
  const eventsBefore = await withdrawalEvents();
  const auditsBefore = await auditCount("report-withdrawn");
  for (const reason of [undefined, "", "   ", "short", "because because", "a b c d e f g h", "x".repeat(40)]) {
    const r = await call(owner, "reports/withdraw", { id, version: (await reportRow(id)).version, ...(reason === undefined ? {} : { reason }) });
    assert.ok(r.status === 422, `${JSON.stringify(reason)} -> ${r.status}`);
  }
  assert.equal((await call(owner, "reports/withdraw", { id, version: (await reportRow(id)).version, reason: "y".repeat(2001) })).status, 422);
  assert.equal((await reportRow(id)).status, "PUBLISHED", "nothing changed");
  assert.equal(await withdrawalEvents(), eventsBefore, "failed attempts write no event");
  assert.equal(await auditCount("report-withdrawn"), auditsBefore);
  const version = (await reportRow(id)).version;
  const started = Date.now();
  const ok = await call(owner, "reports/withdraw", { id, version, reason: `  ${REASON}  ` });
  assert.equal(ok.status, 200, ok.text);
  const marker = (await revisions(id)).at(-1)!;
  const w = (marker.data as { withdrawal: { contentType: string; withdrawnVersion: number; actorId: string; actorRole: string; at: string; reason: string } }).withdrawal;
  assert.deepEqual({ ...w, at: undefined }, { contentType: "report", withdrawnVersion: version, actorId: USERS.owner.id, actorRole: "OWNER", at: undefined, reason: REASON });
  assert.ok(Math.abs(new Date(w.at).getTime() - started) < 60_000);
  assert.equal(marker.version, version + 1);
  assert.equal((marker.data as { status: string }).status, "WITHDRAWN");
  const audits = (await database().select().from(t.audit).where(eq(t.audit.entityId, id))).filter((a) => a.action === "report-withdrawn");
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].actorId, audits[0].academyId, audits[0].version], [USERS.owner.id, "green", version + 1]);
  const events = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "REPORT_WITHDRAWN"))).filter((e) => (e.detail as { ref?: string }).ref === id);
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].actorId, events[0].academyId], [USERS.owner.id, "green"]);
  assert.deepEqual(events[0].detail, { contentType: "report", ref: id, version, actorRole: "OWNER" });
  const text = JSON.stringify(events[0]) + JSON.stringify(audits[0]);
  for (const secret of [CANARY.childA.name, `WD-SUMMARY-${id}`, "paragraph", REASON]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  // The owner reads it in the security log; another academy does not; no content in the response.
  const log = await owner.get(`${API}/security-events?event=REPORT_WITHDRAWN`);
  const shown = (log.json as { events: { label: string; actor: { id: string } | null; detail: Record<string, unknown> }[] }).events.filter((e) => e.detail.ref === id);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].actor?.id, USERS.owner.id);
  assert.deepEqual(shown[0].detail, { contentType: "report", ref: id, version, actorRole: "OWNER" });
  assert.ok(!JSON.stringify(log.json).includes(REASON));
  assert.equal(((await (await as("blueOwner")).get(`${API}/security-events?event=REPORT_WITHDRAWN`)).json as { events: unknown[] }).events.length, 0);
  // The same for a nutrition plan.
  const plan = await seedPlan();
  await sharePlan(plan);
  const pv = (await planRow(plan)).version;
  assert.equal((await call(await as("nutrition"), "nutrition/withdraw", { id: plan, version: pv, reason: REASON })).status, 200);
  const [pe] = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, "NUTRITION_PLAN_WITHDRAWN"))).filter((e) => (e.detail as { ref?: string }).ref === plan);
  assert.deepEqual([pe.actorId, pe.detail], [USERS.nutrition.id, { contentType: "nutrition-plan", ref: plan, version: pv, actorRole: "NUTRITION_PRO" }]);
  assert.ok(!JSON.stringify(pe).includes("WD-GUIDANCE") && !JSON.stringify(pe).includes(REASON));
  // Application routes cannot rewrite history: there is no edit or delete for a revision or an event.
  for (const route of ["reports/revision", "reports/history", "security-events/delete", "nutrition/history"])
    assert.equal((await call(owner, route, { id })).status, 404, route);
});
test("concurrency: simultaneous withdrawals record one; revise-versus-withdraw races leave one consistent outcome; downloads never serve after withdrawal", async () => {
  const id = await seedReport();
  await publishReport(id);
  const owner = await as("owner");
  const admin = await as("admin");
  const version = (await reportRow(id)).version;
  const before = await withdrawalEvents();
  const parallel = await Promise.all([owner, admin, owner, admin, owner].map((c) => c.clone().post(`${API}/reports/withdraw`, { id, version, reason: REASON })));
  assert.equal(parallel.filter((r) => r.status === 200).length, 1, parallel.map((r) => r.status).join());
  assert.ok(parallel.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.equal(await withdrawalEvents(), before + 1);
  assert.equal((await revisions(id)).filter((r) => (r.data as { withdrawal?: unknown }).withdrawal).length, 1);
  assert.equal((await reportRow(id)).version, version + 1);
  // Revise and withdraw at once, from the same version: exactly one wins; the loser is a conflict.
  const raced = await seedReport();
  await publishReport(raced);
  const v = (await reportRow(raced)).version;
  const [revise, withdraw] = await Promise.all([
    owner.clone().post(`${API}/reports/update`, { id: raced, version: v, action: "revise", summary: "", reason: "Fix and reissue." }),
    admin.clone().post(`${API}/reports/withdraw`, { id: raced, version: v, reason: REASON }),
  ]);
  assert.deepEqual([revise.status, withdraw.status].sort(), [200, 409]);
  const hidden = !(await familyReportIds()).includes(raced);
  assert.equal(hidden, withdraw.status === 200, "families see it exactly when the revision won, never after a withdrawal");
  assert.equal((await reportRow(raced)).version, v + 1);
  // A download racing a withdrawal either completes before it or is refused; afterwards always refused.
  const pdfRace = await seedReport();
  await publishReport(pdfRace);
  const guardian = await as("guardian");
  const pv = (await reportRow(pdfRace)).version;
  const [pdf, wd] = await Promise.all([
    guardian.clone().get(`${API}/reports/${pdfRace}/pdf`),
    owner.clone().post(`${API}/reports/withdraw`, { id: pdfRace, version: pv, reason: REASON }),
  ]);
  assert.equal(wd.status, 200);
  assert.ok([200, 404].includes(pdf.status), `status ${pdf.status}`);
  assert.equal(await pdfStatus("guardian", pdfRace), 404);
  // The same for a nutrition plan: parallel withdrawals record one.
  const plan = await seedPlan();
  await sharePlan(plan);
  const nv = (await planRow(plan)).version;
  const pro = await as("nutrition");
  const nBefore = await eventCount("NUTRITION_PLAN_WITHDRAWN");
  const nr = await Promise.all([owner, pro, owner].map((c) => c.clone().post(`${API}/nutrition/withdraw`, { id: plan, version: nv, reason: REASON })));
  assert.equal(nr.filter((r) => r.status === 200).length, 1, nr.map((r) => r.status).join());
  assert.equal(await eventCount("NUTRITION_PLAN_WITHDRAWN"), nBefore + 1);
  assert.ok(!(await familyPlanIds()).includes(plan));
});
test("a failed withdrawal leaves no trace: the transaction rolls back, nothing half-written", async () => {
  const id = await seedReport();
  await publishReport(id);
  const row = await reportRow(id);
  const owner = await as("owner");
  const snapshot = async () => JSON.stringify([await reportRow(id), await revisions(id), await auditCount("report-withdrawn"), await eventCount("REPORT_WITHDRAWN")]);
  const before = await snapshot();
  // Wrong version, bad reason, wrong role, unknown id: each is refused before anything is written.
  assert.equal((await call(owner, "reports/withdraw", { id, version: row.version + 5, reason: REASON })).status, 409);
  assert.equal((await call(owner, "reports/withdraw", { id, version: row.version, reason: "no" })).status, 422);
  assert.equal((await call(await as("coach"), "reports/withdraw", { id, version: row.version, reason: REASON })).status, 403);
  assert.equal((await call(owner, "reports/withdraw", { id: "missing", version: 1, reason: REASON })).status, 404);
  assert.equal((await call(owner, "reports/withdraw", { id, version: "1", reason: REASON })).status, 422);
  assert.equal(await snapshot(), before);
});
test("the PDF: families get none once withdrawn; staff get it clearly marked withdrawn, and the text comes from the same authoritative answer", async () => {
  const id = await seedReport();
  await publishReport(id);
  const captured: string[][] = [];
  const original = pdfRenderer.render;
  pdfRenderer.render = async (academy, title, lines, sheet) => {
    captured.push(lines);
    return original.call(pdfRenderer, academy, title, lines, sheet);
  };
  try {
    const guardian = academyActor("GUARDIAN", USERS.guardian.id);
    const owner = academyActor("OWNER", USERS.owner.id);
    await reportPdf(guardian, id);
    assert.ok(captured.at(-1)!.some((l) => l.includes(`WD-SUMMARY-${id}`)), "a published report renders its content");
    assert.ok(!captured.at(-1)!.some((l) => l.includes("WITHDRAWN")));
    assert.equal((await withdrawR(await as("owner"), id)).status, 200);
    const count = captured.length;
    await assert.rejects(() => reportPdf(guardian, id), (e: unknown) => e instanceof DomainError && e.status === 404);
    assert.equal(captured.length, count, "nothing is even rendered for the family");
    await reportPdf(owner, id);
    const lines = captured.at(-1)!;
    assert.ok(lines.some((l) => l.startsWith("Status: WITHDRAWN")));
    assert.ok(lines.some((l) => l.includes("no longer shared with families")));
  } finally {
    pdfRenderer.render = original;
  }
});
