import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { privateFiles } from "../src/infrastructure/storage/private-files";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import {
  CATEGORIES,
  EXECUTION_ORDER,
  MAX_ATTEMPTS,
  POLICY_PENDING,
  TRANSITIONS,
  REQUEST_STATUSES,
  backoffMinutes,
  canTransition,
  evaluateEligibility,
  graceDays,
  validPrivacyReason,
} from "../src/modules/privacy/domain";
import { requestErasure, setRetentionPolicy } from "../src/modules/privacy/application/service";
import { processDueErasures, processStorageDeletions, reconcileFromLedger, runRequest } from "../src/modules/privacy/application/process";
import { readLedger } from "../src/modules/privacy/application/ledger";
import { CANARY, FIXTURE_PASSWORD, ROLES, ROLE_USER, USERS, addFixtureUser, idsFor, type FixtureUserKey } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, signedIn } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";
/**
 * Phase 8: retention rules, erasure lifecycle, legal holds, execution, recovery and restore safeguards.
 * Real HTTP over the real route handlers for the lifecycle; the processor is driven in-process with an
 * injected clock (there is no scheduler to wait for). Every destructive test erases its OWN freshly seeded
 * player, never a shared fixture, and checks that other people's data is untouched.
 */
let app: Harness;
let dir: string;
let ledger: string;
before(
  async () => {
    dir = mkdtempSync(join(tmpdir(), "p8-"));
    ledger = join(dir, "ledger.jsonl");
    process.env.ERASURE_LEDGER_PATH = ledger;
    app = await startHarness("privacy");
  },
  { timeout: HOOK_TIMEOUT },
);
after(async () => {
  delete process.env.ERASURE_LEDGER_PATH;
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
}, { timeout: HOOK_TIMEOUT });
beforeEach(async () => {
  // Rules are per academy and persist across tests only if a test wants them to: start each test with none.
  await database().delete(t.retentionPolicies);
  await database().update(t.legalHolds).set({ releasedAt: new Date(), releasedBy: "test", releaseReason: "test cleanup" }).where(sql`released_at is null`);
});
const API = "/api/academy";
const as = (key: FixtureUserKey) => app.as(key);
const post = (client: TestClient, route: string, body: unknown) => client.post(`${API}/${route}`, body);
const PW = { ownerPassword: FIXTURE_PASSWORD };
const WHY = "The family asked for their child's data to be erased in writing.";
const BASIS = "Approved by the academy's trustees on the date minuted in the privacy register.";
const actorOf = (key: FixtureUserKey, role?: string, academyId = "green"): Actor => ({ id: USERS[key].id, name: "x", academyId, role: role ?? USERS[key].role, timezone: "UTC", academyName: "x" });
const db = () => database();
let counter = 0;
/** Approves a rule for every configurable category (or only `only`). */
async function approve(only?: string[], days: number | null = null) {
  const owner = await as("owner");
  for (const c of CATEGORIES.filter((x) => x.actions.length && (!only || only.includes(x.key)))) {
    const r = await post(owner, "privacy/policy", { category: c.key, decision: "APPROVE", action: c.actions[0], retentionDays: days, basis: BASIS, ...PW });
    assert.equal(r.status, 200, `${c.key}: ${r.text}`);
  }
}
// ----------------------------------------------------------------------------------------------------
// A complete, disposable subject: one player with data in every category.
// ----------------------------------------------------------------------------------------------------
type Subject = Awaited<ReturnType<typeof seedSubject>>;
async function seedSubject() {
  const n = ++counter;
  const id = `p8-player-${n}-end`;
  const name = `Erasable-Name-${n}`;
  const mark = (what: string) => `P8-${what}-${n}`;
  const canary = { name, email: `${mark("EMAIL")}@example.test`, phone: mark("PHONE"), notes: mark("NOTES"), report: mark("REPORT"), plan: mark("PLAN"), allergy: mark("ALLERGY"), chat: mark("CHAT"), goal: mark("GOAL"), history: mark("HISTORY"), observation: mark("OBSERVATION"), review: mark("REVIEW"), enquiry: mark("ENQUIRY") };
  const q = db();
  await q.insert(t.players).values({ id, academyId: "green", name, batchId: "green-main" });
  const profile = { adult: false, birthDate: "2015-05-05", email: canary.email, phone: canary.phone, notes: canary.notes, status: "ARCHIVED" as const, selfUserId: null, preferences: "none" };
  await q.insert(t.profiles).values({ academyId: "green", playerId: id, data: profile });
  await q.insert(t.recordRevisions).values({ id: `rev-prof-${id}`, academyId: "green", entityId: id, kind: "player-profile", version: 1, data: { name, ...profile } });
  await q.insert(t.guardianLinks).values({ academyId: "green", playerId: id, userId: USERS.guardian2.id, active: true, relationship: "Mother", consent: { portal: true, email: true, whatsapp: false } });
  await q.insert(t.consentEvents).values({ id: `ce-${id}`, academyId: "green", playerId: id, subjectUserId: USERS.guardian2.id, category: "EMAIL", sequence: 1, decision: "GRANTED", method: "PORTAL_SELF" });
  const reportId = `rep-${id}`;
  const report = { playerId: id, periodStart: "2027-01-01", periodEnd: "2027-01-31", title: "Report", summary: canary.report, evidence: [], academyName: "x", playerName: name, reviewer: null, approvedAt: null };
  await q.insert(t.reports).values({ id: reportId, academyId: "green", playerId: id, version: 2, status: "PUBLISHED", data: report });
  for (const v of [1, 2]) await q.insert(t.recordRevisions).values({ id: `rev-rep-${id}-${v}`, academyId: "green", entityId: reportId, kind: "report", version: v, data: { status: v === 2 ? "PUBLISHED" : "DRAFT", data: report } });
  const planId = `plan-${id}`;
  const plan = { playerId: id, title: "Plan", guidance: canary.plan, professional: null, reviewNote: "", approvedAt: null };
  await q.insert(t.nutritionPlans).values({ id: planId, academyId: "green", playerId: id, version: 1, status: "SHARED", data: plan });
  await q.insert(t.recordRevisions).values({ id: `rev-plan-${id}`, academyId: "green", entityId: planId, kind: "nutrition-plan", version: 1, data: { status: "SHARED", data: plan } });
  await q.insert(t.restrictedNutrition).values({ academyId: "green", playerId: id, allergies: canary.allergy, restrictions: "" });
  await q.insert(t.nutritionQuestions).values({ id: `nq-${id}`, academyId: "green", playerId: id, authorId: USERS.guardian2.id, question: canary.allergy });
  await q.insert(t.nutritionAssignments).values({ academyId: "green", playerId: id, professionalId: USERS.nutrition.id, active: true });
  // A private file that really exists in storage.
  const mediaId = crypto.randomUUID();
  const storageKey = `${"a1b2c3d4e5f60718"}/${mediaId}`;
  await privateFiles.put(storageKey, Buffer.from(`P8-FILE-${n}`));
  await q.insert(t.mediaAssets).values({ id: mediaId, academyId: "green", playerId: id, ownerId: USERS.coach.id, name: `${name}.png`, mime: "image/png", size: 10, storageKey, expiresAt: new Date(Date.now() + 86_400_000) });
  await q.insert(t.recordRevisions).values({ id: `rev-media-${id}`, academyId: "green", entityId: mediaId, kind: "media", version: 1, data: { playerId: id, name } });
  await q.insert(t.conversations).values({ id: `conv-${id}`, playerId: id, academyId: "green", guardianId: USERS.guardian2.id, subject: "Hello", entries: [{ id: "e1", authorId: USERS.guardian2.id, name: "G", text: canary.chat, at: new Date().toISOString() }] });
  await q.insert(t.goals).values({ id: `goal-${id}`, academyId: "green", playerId: id, data: { id: `goal-${id}`, playerId: id, title: canary.goal, method: "m", status: "ACTIVE" } as never });
  await q.insert(t.playerHistory).values({ id: `hist-${id}`, academyId: "green", playerId: id, kind: "NOTE", detail: { note: canary.history } });
  // A session shared with another child: this player's name and observation must go, the other child's stay.
  const [base] = await q.select().from(t.trainingSessions).where(eq(t.trainingSessions.id, idsFor("childA").sessionId));
  const sessionId = `sess-${id}`;
  const data = { ...base.data, roster: [{ id, name }, { id: idsFor("childA").playerId, name: CANARY.childA.name }], attendance: { [id]: "PRESENT", [idsFor("childA").playerId]: "PRESENT" } as never, observations: [{ id: `o1-${id}`, playerId: id, activityId: null, text: canary.observation, author: "Coach", at: "x", visibility: "PRIVATE_DRAFT" as const }, { id: `o2-${id}`, playerId: idsFor("childA").playerId, activityId: null, text: "OTHER-CHILD-OBSERVATION", author: "Coach", at: "x", visibility: "PRIVATE_DRAFT" as const }], adjustments: [{ playerId: id, focus: canary.observation }] };
  await q.insert(t.trainingSessions).values({ id: sessionId, academyId: "green", coachId: base.coachId, batchId: base.batchId, status: "COMPLETED", data });
  await q.insert(t.revisions).values({ academyId: "green", sessionId, version: 1, status: "COMPLETED", data });
  await q.insert(t.observationReviews).values({ academyId: "green", sessionId, observationId: `o1-${id}`, approvedText: canary.review, reviewerId: USERS.coach.id });
  const enquiryId = `enq-${id}`;
  const enquiry = { name, email: canary.email, phone: canary.phone, adult: false, source: "web", followUpDate: "", notes: canary.enquiry, trialEventId: null, trialAttendance: "NOT_MARKED" as const, feedback: canary.enquiry, playerId: id };
  await q.insert(t.enquiries).values({ id: enquiryId, academyId: "green", status: "ENROLLED", data: enquiry });
  await q.insert(t.recordRevisions).values({ id: `rev-enq-${id}`, academyId: "green", entityId: enquiryId, kind: "enquiry", version: 1, data: { data: enquiry } });
  // Retained evidence that refers to the player.
  await q.insert(t.invoices).values({ id: `inv-${id}`, academyId: "green", data: { number: `INV-${n}`, playerIds: [id], familyUserId: null, planId: null, description: "Fees", currency: "INR", subtotal: 100, discount: 0, total: 100, dueDate: "2027-01-01", issuedAt: "2027-01-01", voidReason: "" } });
  await q.insert(t.lessonCredits).values({ id: `lc-${id}`, academyId: "green", playerId: id, units: 1, reason: "credit", idempotencyKey: `p8-${id}` });
  await q.insert(t.messages).values({ id: `msg-${id}`, authorId: USERS.owner.id, academyId: "green", data: { subject: "Broadcast", body: "Hello all", playerIds: [id], batchIds: [], allBatches: false, channels: ["PORTAL"], recipients: [], scheduledAt: null } as never });
  await q.insert(t.accessEvents).values({ id: `ae-${id}`, academyId: "green", actorId: USERS.owner.id, actorRole: "OWNER", category: "REPORT", operation: "VIEW", outcome: "SUCCESS", resourceId: reportId, playerId: id, channel: "service" });
  return { id, name, canary, reportId, planId, mediaId, storageKey, sessionId, enquiryId };
}
const fileExists = async (key: string) => privateFiles.get(key).then(() => true, () => false);
/** Everything about a fixture child that an erasure of somebody else must leave alone. */
async function fingerprint(playerId: string) {
  const q = db();
  return JSON.stringify([
    await q.select().from(t.players).where(eq(t.players.id, playerId)),
    await q.select().from(t.profiles).where(eq(t.profiles.playerId, playerId)),
    await q.select().from(t.guardianLinks).where(eq(t.guardianLinks.playerId, playerId)),
    await q.select().from(t.reports).where(eq(t.reports.playerId, playerId)),
    await q.select().from(t.nutritionPlans).where(eq(t.nutritionPlans.playerId, playerId)),
    await q.select().from(t.mediaAssets).where(eq(t.mediaAssets.playerId, playerId)),
    await q.select().from(t.conversations).where(eq(t.conversations.playerId, playerId)),
    await q.select().from(t.goals).where(eq(t.goals.playerId, playerId)),
    await q.select().from(t.trainingSessions).where(eq(t.trainingSessions.id, idsFor("childA").sessionId)),
  ]);
}
const request = async (client: TestClient, subject: { id: string }, reason = WHY) => post(client, "privacy/request", { playerId: subject.id, reason });
type Req = { id: string; version: number; status: string; executeAfter: string | null };
const row = async (id: string) => (await db().select().from(t.erasureRequests).where(eq(t.erasureRequests.id, id)))[0];
const events = async (id: string) => db().select().from(t.erasureEvents).where(eq(t.erasureEvents.requestId, id)).orderBy(asc(t.erasureEvents.at), asc(t.erasureEvents.id));
const secEvents = async (event: string) => (await db().select().from(t.securityEvent).where(eq(t.securityEvent.event, event)));
/** Requests as ADMIN, approves as OWNER, then skips the grace period. */
async function approvedRequest(subject: { id: string }) {
  const admin = await as("admin");
  const owner = await as("owner");
  const made = await request(admin, subject);
  assert.equal(made.status, 200, made.text);
  const req = made.json as Req;
  const ok = await post(owner, "privacy/review", { id: req.id, version: req.version, decision: "APPROVE", reason: "Reviewed the preview and the family's written request.", ...PW });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((ok.json as Req).status, "GRACE_PERIOD");
  return req.id;
}
const skipGrace = (id: string) => db().update(t.erasureRequests).set({ executeAfter: new Date(Date.now() - 60_000) }).where(eq(t.erasureRequests.id, id));
const runAll = (now?: Date) => processDueErasures({ now });
test("pure rules: the state machine, eligibility, no invented retention, bounded retry", () => {
  for (const from of REQUEST_STATUSES) for (const to of REQUEST_STATUSES) assert.equal(canTransition(from, to), TRANSITIONS[from].includes(to), `${from}->${to}`);
  for (const terminal of ["COMPLETED", "REJECTED", "CANCELLED", "FAILED"]) assert.deepEqual(TRANSITIONS[terminal as keyof typeof TRANSITIONS], [], terminal);
  assert.equal(canTransition("PREVIEW_READY", "PROCESSING"), false, "nothing skips the grace period");
  assert.equal(canTransition("PREVIEW_READY", "COMPLETED"), false);
  assert.equal(canTransition("GRACE_PERIOD", "COMPLETED"), false);
  const now = new Date("2030-06-01T00:00:00Z");
  const left = new Date("2030-01-01T00:00:00Z");
  const rule = (status = "APPROVED", retentionDays: number | null = null) => ({ category: "REPORTS", status, action: "ERASE", retentionDays });
  assert.deepEqual(evaluateEligibility(null, { leftAt: left }, now), { eligible: false, reason: "REQUIRES_POLICY_APPROVAL" });
  assert.deepEqual(evaluateEligibility(rule("SUSPENDED"), { leftAt: left }, now), { eligible: false, reason: "REQUIRES_POLICY_APPROVAL" });
  assert.deepEqual(evaluateEligibility(rule(), { leftAt: null }, now), { eligible: true, action: "ERASE", basis: "ON_REQUEST" });
  assert.deepEqual(evaluateEligibility(rule("APPROVED", 30), { leftAt: null }, now), { eligible: false, reason: "SUBJECT_STILL_ACTIVE" });
  const edge = new Date(left.getTime() + 30 * 86_400_000);
  assert.equal(evaluateEligibility(rule("APPROVED", 30), { leftAt: left }, new Date(edge.getTime() - 1)).eligible, false);
  assert.equal(evaluateEligibility(rule("APPROVED", 30), { leftAt: left }, edge).eligible, true, "exactly at the end of the period");
  assert.equal(graceDays({}), 14);
  assert.equal(graceDays({ ERASURE_GRACE_DAYS: "30" }), 30);
  for (const bad of ["0", "-1", "366", "abc", "1.5", ""]) assert.equal(graceDays({ ERASURE_GRACE_DAYS: bad }), 14, bad);
  assert.deepEqual([1, 2, 3, 10].map(backoffMinutes), [2, 4, 8, 60]);
  assert.ok(MAX_ATTEMPTS >= 3 && MAX_ATTEMPTS <= 10);
  for (const bad of ["", "short", "because because", "x".repeat(40), "a b c d e"]) assert.equal(validPrivacyReason(bad), false, bad);
  assert.equal(validPrivacyReason(WHY), true);
  // The registry invents nothing: every configurable category is pending approval, evidence is fixed, and no
  // duration appears anywhere in it.
  for (const c of CATEGORIES) {
    assert.equal(c.legal, POLICY_PENDING, c.key);
    if (!c.actions.length) assert.ok(c.fixedReason, `${c.key} says why it is fixed`);
  }
  assert.deepEqual(CATEGORIES.filter((c) => !c.actions.length).map((c) => c.key).sort(), ["AUDIT_RECORDS", "CONSENT_EVIDENCE", "FINANCE", "MESSAGES_AND_CALENDAR"]);
  assert.equal(JSON.stringify(CATEGORIES).match(/\b\d+ (days|years|months)\b/i), null);
  assert.deepEqual([...EXECUTION_ORDER].slice(0, 1), ["MEDIA"]);
  assert.equal(EXECUTION_ORDER.at(-1), "PLAYER_PROFILE", "identity is erased last");
});
test("retention rules: none by default (REQUIRES POLICY APPROVAL), owner-only with re-authentication, evidence categories cannot be given an erase rule", async () => {
  const owner = await as("owner");
  const o = (await owner.get(`${API}/privacy/overview`)).json as { categories: { key: string; policyStatus: string }[]; graceDays: number; ledgerConfigured: boolean };
  assert.equal(o.graceDays, 14);
  assert.equal(o.ledgerConfigured, true);
  for (const c of o.categories) assert.equal(c.policyStatus, CATEGORIES.find((x) => x.key === c.key)!.actions.length ? POLICY_PENDING : "FIXED", c.key);
  const body = { category: "REPORTS", decision: "APPROVE", action: "ERASE", retentionDays: null, basis: BASIS, ...PW };
  // Only the owner. Everyone else is refused, and nothing is stored.
  for (const role of ROLES) {
    if (role === "OWNER") continue;
    assert.equal((await post(await as(ROLE_USER[role]), "privacy/policy", body)).status, 403, role);
  }
  assert.equal((await db().select().from(t.retentionPolicies)).length, 0);
  assert.equal((await post(owner, "privacy/policy", { ...body, ownerPassword: "Wrong-Owner-Password-123" })).status, 403);
  assert.equal(code(await post(owner, "privacy/policy", { ...body, basis: "ok" })), "REASON_REQUIRED");
  assert.equal(code(await post(owner, "privacy/policy", { ...body, action: "ANONYMIZE" })), "ACTION_NOT_SUPPORTED");
  assert.equal(code(await post(owner, "privacy/policy", { ...body, category: "FINANCE" })), "FIXED_RETENTION");
  assert.equal(code(await post(owner, "privacy/policy", { ...body, category: "CONSENT_EVIDENCE" })), "FIXED_RETENTION");
  assert.equal(code(await post(owner, "privacy/policy", { ...body, category: "AUDIT_RECORDS" })), "FIXED_RETENTION");
  assert.equal((await post(owner, "privacy/policy", { ...body, category: "NOPE" })).status, 404);
  assert.equal((await post(owner, "privacy/policy", { ...body, retentionDays: -1 })).status, 422);
  assert.equal((await db().select().from(t.retentionPolicies)).length, 0, "no refused request stored anything");
  const before = (await secEvents("RETENTION_POLICY_CHANGED")).length;
  assert.equal((await post(owner, "privacy/policy", { ...body, retentionDays: 365 })).status, 200);
  const [stored] = await db().select().from(t.retentionPolicies);
  assert.deepEqual([stored.category, stored.action, stored.retentionDays, stored.approvedBy, stored.status], ["REPORTS", "ERASE", 365, USERS.owner.id, "APPROVED"]);
  const ev = (await secEvents("RETENTION_POLICY_CHANGED")).slice(before);
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].detail, { category: "REPORTS", action: "ERASE", days: 365 });
  assert.ok(!JSON.stringify(ev[0]).includes("trustees"), "the basis text is not copied into the security log");
  assert.equal((await post(owner, "privacy/policy", { category: "REPORTS", decision: "SUSPEND", basis: BASIS, ...PW })).status, 200);
  assert.equal((await db().select().from(t.retentionPolicies))[0].status, "SUSPENDED");
  assert.equal((await post(owner, "privacy/policy", { category: "NUTRITION", decision: "SUSPEND", basis: BASIS, ...PW })).status, 404, "nothing to suspend");
});
test("an unapproved policy cannot trigger deletion: a request can be raised and previewed, but approval is refused and nothing changes", async () => {
  const s = await seedSubject();
  const admin = await as("admin");
  const owner = await as("owner");
  const made = await request(admin, s);
  assert.equal(made.status, 200, made.text);
  const req = made.json as Req & { preview: { willAct: unknown[]; categories: { key: string; outcome: string; records: number }[] } };
  assert.equal(req.status, "PREVIEW_READY");
  assert.deepEqual(req.preview.willAct, []);
  const by = (k: string) => req.preview.categories.find((c) => c.key === k)!;
  assert.equal(by("REPORTS").outcome, "REQUIRES_POLICY_APPROVAL");
  assert.equal(by("REPORTS").records, 1, "the preview still tells what exists");
  assert.equal(by("FINANCE").outcome, "RETAINED_FIXED");
  const r = await post(owner, "privacy/review", { id: req.id, version: req.version, decision: "APPROVE", reason: "Reviewed the preview.", ...PW });
  assert.equal(r.status, 409);
  assert.equal(code(r), "NOTHING_TO_ERASE");
  assert.equal((await row(req.id)).status, "PREVIEW_READY");
  assert.equal((await runAll()).length, 0);
  assert.equal(await db().select().from(t.reports).where(eq(t.reports.playerId, s.id)).then((x) => x.length), 1);
  assert.equal((await db().select().from(t.players).where(eq(t.players.id, s.id)))[0].name, s.name);
});
test("authorization: only owner and admin; other roles, other academies, anonymous callers and deactivated members are refused, and refusals are recorded", async () => {
  const s = await seedSubject();
  for (const role of ROLES) {
    const client = await as(ROLE_USER[role]);
    const ov = await client.get(`${API}/privacy/overview`);
    const made = role === "OWNER" || role === "ADMIN" ? null : await request(client, s);
    if (role === "OWNER" || role === "ADMIN") assert.equal(ov.status, 200, role);
    else {
      assert.equal(ov.status, 403, role);
      assert.equal(made!.status, 403, role);
      assert.equal((await post(client, "privacy/process", {})).status, 403, role);
    }
  }
  assert.equal((await db().select().from(t.erasureRequests).where(eq(t.erasureRequests.playerId, s.id))).length, 0);
  const denied = await db().select().from(t.accessEvents).where(and(eq(t.accessEvents.category, "PRIVACY"), eq(t.accessEvents.outcome, "DENIED"), eq(t.accessEvents.actorId, USERS.coach.id)));
  assert.ok(denied.length >= 1, "the refused attempt is in the access history");
  // Another academy: its owner cannot see or raise anything about this player, and sees nothing of ours.
  const blue = await as("blueOwner");
  assert.equal((await request(blue, s)).status, 404);
  const blueOverview = (await blue.get(`${API}/privacy/overview`)).json as { requests: unknown[]; holds: unknown[] };
  assert.deepEqual([blueOverview.requests.length, blueOverview.holds.length], [0, 0]);
  assert.equal((await app.anonymous().post(`${API}/privacy/request`, { playerId: s.id, reason: WHY })).status, 401);
  assert.equal((await blue.post(`${API}/privacy/request`, { playerId: s.id, reason: WHY }, { origin: "https://evil.example" })).status, 403);
  // A deactivated administrator loses it at once; the services also refuse a forged role.
  const { id, email } = await addFixtureUser("p8-admin", [{ academyId: "green", role: "ADMIN" }]);
  const gone = await signedIn(app, email, FIXTURE_PASSWORD);
  assert.equal((await gone.get(`${API}/privacy/overview`)).status, 200);
  await db().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, id));
  assert.ok([401, 403].includes((await gone.get(`${API}/privacy/overview`)).status));
  await assert.rejects(() => requestErasure(actorOf("coach"), { playerId: s.id, reason: WHY }), (e: unknown) => e instanceof DomainError && e.status === 403);
  await assert.rejects(() => setRetentionPolicy(actorOf("admin"), { category: "REPORTS", decision: "APPROVE", action: "ERASE", basis: BASIS, ownerPassword: FIXTURE_PASSWORD }), (e: unknown) => e instanceof DomainError && e.status === 403);
  await assert.rejects(() => requestErasure(actorOf("blueOwner", undefined, "blue"), { playerId: s.id, reason: WHY }), (e: unknown) => e instanceof DomainError && e.status === 404);
  // No route executes anything directly, and a request body cannot set its own state.
  const owner = await as("owner");
  for (const route of ["privacy/execute", "privacy/erase", "privacy/complete", "privacy/requests/x"]) assert.equal((await post(owner, route, { playerId: s.id })).status, 404, route);
});
test("lifecycle: raise, preview, a different person decides, grace period, cancellation; duplicates, self-approval, stale versions and invalid moves are refused", async () => {
  await approve();
  const s = await seedSubject();
  const admin = await as("admin");
  const owner = await as("owner");
  const dep = await request(admin, s, "short");
  assert.equal(code(dep), "REASON_REQUIRED");
  const made = await request(admin, s);
  assert.equal(made.status, 200, made.text);
  const req = made.json as Req & { preview: { willAct: unknown[]; categories: { outcome: string }[] } };
  assert.equal(req.status, "PREVIEW_READY");
  assert.equal(req.preview.willAct.length, 9, "all nine configurable categories have data");
  assert.equal(code(await request(owner, s)), "DUPLICATE_OPEN_REQUEST");
  assert.equal(code(await request(admin, s)), "DUPLICATE_OPEN_REQUEST");
  const decide = (client: TestClient, extra: Record<string, unknown> = {}) => post(client, "privacy/review", { id: req.id, version: req.version, decision: "APPROVE", reason: "Reviewed the preview and the written request.", ...PW, ...extra });
  assert.equal(code(await decide(admin)), "SELF_APPROVAL_FORBIDDEN", "whoever raised it cannot decide it");
  assert.equal((await post(admin, "privacy/review", { id: req.id, version: req.version, decision: "REJECT", reason: "Rejecting my own request.", ...PW })).status, 403);
  assert.equal((await decide(owner, { ownerPassword: "Wrong-Owner-Password-123" })).status, 403);
  assert.equal(code(await decide(owner, { reason: "ok" })), "REASON_REQUIRED");
  assert.equal((await decide(owner, { version: req.version + 7 })).status, 409, "a stale version");
  assert.equal((await row(req.id)).status, "PREVIEW_READY", "every refusal left it as it was");
  const approvedAt = Date.now();
  const ok = await decide(owner);
  assert.equal(ok.status, 200, ok.text);
  const approved = ok.json as Req;
  assert.equal(approved.status, "GRACE_PERIOD");
  const days = (new Date(approved.executeAfter!).getTime() - approvedAt) / 86_400_000;
  assert.ok(days > 13.99 && days < 14.01, `grace ${days}`);
  const stored = await row(req.id);
  assert.deepEqual([stored.reviewedBy, stored.requestedBy, (stored.plan as unknown[]).length], [USERS.owner.id, USERS.admin.id, 9]);
  // Invalid moves.
  assert.equal(code(await decide(owner, { version: approved.version })), "INVALID_STATE", "cannot be approved twice");
  assert.equal(code(await post(owner, "privacy/preview", { id: req.id })), "INVALID_STATE");
  // The grace period is real: processing before it ends does nothing.
  assert.equal((await runAll()).length, 0);
  assert.equal((await db().select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 1);
  assert.equal((await processDueErasures({ now: new Date(new Date(approved.executeAfter!).getTime() - 1000) })).length, 0, "one second before the deadline");
  // Cancelling during the grace period (by the requester or anyone allowed) ends it for good.
  assert.equal(code(await post(admin, "privacy/cancel", { id: req.id, reason: "x" })), "REASON_REQUIRED");
  const cancelled = await post(admin, "privacy/cancel", { id: req.id, reason: "The family has changed its mind about the request." });
  assert.equal(cancelled.status, 200, cancelled.text);
  assert.equal((cancelled.json as Req).status, "CANCELLED");
  assert.equal(code(await post(owner, "privacy/cancel", { id: req.id, reason: "Cancelling a second time over." })), "INVALID_STATE");
  await skipGrace(req.id);
  assert.equal((await runAll()).length, 0, "a cancelled request never runs");
  assert.equal((await db().select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 1);
  // The history says what happened, in order, and cannot be changed.
  const history = (await events(req.id)).map((e) => e.event);
  assert.deepEqual(history, ["REQUESTED", "PREVIEW_GENERATED", "APPROVED", "CANCELLED"]);
  const names = (pattern: RegExp) => (err: unknown) => pattern.test(`${err} ${(err as { cause?: unknown }).cause}`);
  await assert.rejects(() => db().update(t.erasureEvents).set({ reason: "x" }).where(eq(t.erasureEvents.requestId, req.id)), names(/append-only/));
  await assert.rejects(() => db().delete(t.erasureEvents).where(eq(t.erasureEvents.requestId, req.id)), names(/append-only/));
  await assert.rejects(() => db().execute(sql`truncate erasure_event`), names(/append-only/));
  // A new request is possible once the first is closed; a rejected one is final.
  const again = (await request(owner, s)).json as Req;
  const rejected = await post(admin, "privacy/review", { id: again.id, version: again.version, decision: "REJECT", reason: "The request cannot be verified as genuine.", ...PW });
  assert.equal((rejected.json as Req).status, "REJECTED");
  assert.equal(code(await post(owner, "privacy/review", { id: again.id, version: again.version + 1, decision: "APPROVE", reason: "Trying to approve a rejected one.", ...PW })), "INVALID_STATE");
  // Too late to cancel once processing has started.
  const third = (await request(admin, s)).json as Req;
  await db().update(t.erasureRequests).set({ status: "PROCESSING", lockedBy: "x", lockedUntil: new Date(Date.now() + 600_000) }).where(eq(t.erasureRequests.id, third.id));
  assert.equal(code(await post(owner, "privacy/cancel", { id: third.id, reason: "Trying to stop it half way." })), "TOO_LATE");
  await db().update(t.erasureRequests).set({ status: "CANCELLED", lockedBy: null, lockedUntil: null }).where(eq(t.erasureRequests.id, third.id));
});
test("execution: every approved category is erased or anonymised, evidence is kept, nobody else is touched, nothing is left behind", async () => {
  await approve();
  const s = await seedSubject();
  const other = await fingerprint(idsFor("childB").playerId);
  const otherA = await fingerprint(idsFor("childA").playerId);
  assert.ok(await fileExists(s.storageKey));
  const id = await approvedRequest(s);
  await skipGrace(id);
  const out = await runAll();
  assert.deepEqual(out.map((o) => [o.id, o.status]), [[id, "COMPLETED"]]);
  const q = db();
  // Erased outright.
  for (const [table, col] of [[t.reports, t.reports.playerId], [t.nutritionPlans, t.nutritionPlans.playerId], [t.restrictedNutrition, t.restrictedNutrition.playerId], [t.nutritionQuestions, t.nutritionQuestions.playerId], [t.nutritionAssignments, t.nutritionAssignments.playerId], [t.mediaAssets, t.mediaAssets.playerId], [t.conversations, t.conversations.playerId], [t.goals, t.goals.playerId], [t.playerHistory, t.playerHistory.playerId]] as const)
    assert.equal((await q.select().from(table as typeof t.reports).where(eq(col as typeof t.reports.playerId, s.id))).length, 0, String((table as { _: { name: string } })._?.name));
  const revs = await q.select().from(t.recordRevisions).where(inArray(t.recordRevisions.entityId, [s.reportId, s.planId, s.mediaId, s.id, s.enquiryId]));
  assert.equal(revs.length, 0, "every historical copy is gone too");
  assert.equal(await fileExists(s.storageKey), false, "the private file is gone from storage");
  assert.deepEqual((await q.select().from(t.storageDeletions).where(eq(t.storageDeletions.requestId, id))).map((d) => d.status), ["DONE"]);
  // Anonymised, not removed: the identity, links, sessions, enquiry and profile.
  assert.equal((await q.select().from(t.players).where(eq(t.players.id, s.id)))[0].name, "Erased player");
  const [profile] = await q.select().from(t.profiles).where(eq(t.profiles.playerId, s.id));
  assert.deepEqual([profile.data.email, profile.data.phone, profile.data.notes, profile.data.birthDate, profile.data.status], ["", "", "", "", "ARCHIVED"]);
  const [link] = await q.select().from(t.guardianLinks).where(eq(t.guardianLinks.playerId, s.id));
  assert.deepEqual([link.active, link.relationship], [false, "Erased"]);
  const [session] = await q.select().from(t.trainingSessions).where(eq(t.trainingSessions.id, s.sessionId));
  assert.ok(!JSON.stringify(session.data).includes(s.name) && !JSON.stringify(session.data).includes(s.canary.observation));
  assert.ok(JSON.stringify(session.data).includes("OTHER-CHILD-OBSERVATION") && JSON.stringify(session.data).includes(CANARY.childA.name), "the other child in the same session is untouched");
  const [sessionRevision] = await q.select().from(t.revisions).where(eq(t.revisions.sessionId, s.sessionId));
  assert.ok(!JSON.stringify(sessionRevision.data).includes(s.name));
  assert.equal((await q.select().from(t.observationReviews).where(eq(t.observationReviews.sessionId, s.sessionId))).length, 0);
  const [enquiry] = await q.select().from(t.enquiries).where(eq(t.enquiries.id, s.enquiryId));
  assert.deepEqual([enquiry.data.name, enquiry.data.email, enquiry.data.phone, enquiry.data.notes, enquiry.data.feedback, enquiry.data.playerId], ["Erased player", "", "", "", "", s.id]);
  // Kept, on purpose.
  assert.equal((await q.select().from(t.consentEvents).where(eq(t.consentEvents.playerId, s.id))).length, 1, "consent evidence");
  assert.equal((await q.select().from(t.invoices).where(eq(t.invoices.id, `inv-${s.id}`))).length, 1, "financial records");
  assert.equal((await q.select().from(t.lessonCredits).where(eq(t.lessonCredits.playerId, s.id))).length, 1);
  assert.equal((await q.select().from(t.messages).where(eq(t.messages.id, `msg-${s.id}`))).length, 1, "broadcast messages need a policy decision");
  assert.equal((await q.select().from(t.accessEvents).where(eq(t.accessEvents.playerId, s.id))).length, 1, "audit history");
  // Foreign keys: nothing refers to a row that is no longer there.
  const orphans = await q.execute(sql`select count(*)::int as n from consent_event c left join guardian_link g on g.academy_id = c.academy_id and g.player_id = c.player_id and g.user_id = c.subject_user_id where g.player_id is null`);
  assert.equal((orphans.rows[0] as { n: number }).n, 0);
  // Other people's data is exactly as it was.
  assert.equal(await fingerprint(idsFor("childB").playerId), other);
  assert.equal(await fingerprint(idsFor("childA").playerId), otherA);
  // The request tells what was done; the ledger has one line; the security log has the milestones.
  const done = await row(id);
  assert.equal(done.status, "COMPLETED");
  assert.ok(done.completedAt);
  assert.deepEqual((done.steps as { status: string }[]).map((x) => x.status), Array(9).fill("DONE"));
  assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 1);
  for (const e of ["ERASURE_REQUESTED", "ERASURE_APPROVED", "ERASURE_COMPLETED"]) assert.ok((await secEvents(e)).some((x) => (x.detail as { ref?: string }).ref === id), e);
  // Idempotent: running everything again changes nothing and writes nothing.
  const eventCount = (await events(id)).length;
  assert.equal((await runAll()).length, 0);
  assert.equal((await runRequest("green", id)).note, "not claimed");
  assert.equal((await events(id)).length, eventCount);
  assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 1);
  // No trace of the person in anything written about the erasure itself.
  const trace = JSON.stringify([done, await events(id), await secEvents("ERASURE_COMPLETED"), await secEvents("ERASURE_REQUESTED"), readFileSync(ledger, "utf8")]);
  for (const secret of [...Object.values(s.canary), s.name]) assert.ok(!trace.includes(secret), `leaked ${secret}`);
  // Staff see an erased player; the family has no access to the child any more.
  const staff = (await (await as("owner")).get(API)).json as { players: { id: string; name: string }[] };
  assert.equal(staff.players.find((p) => p.id === s.id)?.name, "Erased player");
});
test("only what the owner approved is erased; a rule suspended before execution is respected; unapproved categories are reported, not touched", async () => {
  await approve(["MEDIA", "REPORTS", "NUTRITION"]);
  const s = await seedSubject();
  const admin = await as("admin");
  const owner = await as("owner");
  const req = (await request(admin, s)).json as Req & { preview: { categories: { key: string; outcome: string }[] } };
  const outcome = (k: string) => req.preview.categories.find((c) => c.key === k)!.outcome;
  assert.deepEqual(["MEDIA", "REPORTS", "NUTRITION"].map(outcome), ["WILL_ERASE", "WILL_ERASE", "WILL_ERASE"]);
  assert.equal(outcome("CONVERSATIONS"), "REQUIRES_POLICY_APPROVAL");
  assert.equal(outcome("PLAYER_PROFILE"), "REQUIRES_POLICY_APPROVAL");
  assert.equal(outcome("FINANCE"), "RETAINED_FIXED");
  await post(owner, "privacy/review", { id: req.id, version: req.version, decision: "APPROVE", reason: "Reviewed the preview and the written request.", ...PW });
  // The owner suspends the NUTRITION rule while the grace period runs.
  await post(owner, "privacy/policy", { category: "NUTRITION", decision: "SUSPEND", basis: BASIS, ...PW });
  await skipGrace(req.id);
  assert.equal((await runAll())[0].status, "COMPLETED");
  const steps = (await row(req.id)).steps as { category: string; status: string; code?: string }[];
  assert.deepEqual(steps.map((x) => [x.category, x.status, x.code ?? null]), [["MEDIA", "DONE", null], ["REPORTS", "DONE", null], ["NUTRITION", "SKIPPED", "POLICY_CHANGED"]]);
  assert.equal((await db().select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 0);
  assert.equal((await db().select().from(t.nutritionPlans).where(eq(t.nutritionPlans.playerId, s.id))).length, 1, "suspended rule: kept");
  assert.equal((await db().select().from(t.conversations).where(eq(t.conversations.playerId, s.id))).length, 1, "never approved: kept");
  assert.equal((await db().select().from(t.players).where(eq(t.players.id, s.id)))[0].name, s.name, "identity kept while its rule is not approved");
});
test("legal holds: owner or admin places (with re-authentication), only the owner releases; a hold blocks everything, is rechecked at execution, and a release forces a fresh review", async () => {
  await approve();
  const s = await seedSubject();
  const t2 = await seedSubject();
  const admin = await as("admin");
  const owner = await as("owner");
  const id = await approvedRequest(s);
  // Placing: reason, password, roles.
  const hold = { playerId: s.id, reason: "Pending a safeguarding enquiry by the governing body." };
  assert.equal((await post(await as("coach"), "privacy/hold", { ...hold, ...PW })).status, 403);
  assert.equal((await post(admin, "privacy/hold", { ...hold, ownerPassword: "Wrong-Owner-Password-123" })).status, 403);
  assert.equal(code(await post(admin, "privacy/hold", { ...hold, reason: "no", ...PW })), "REASON_REQUIRED");
  assert.equal((await post(admin, "privacy/hold", { ...hold, playerId: "no-such-player", ...PW })).status, 404);
  assert.equal((await post(await as("blueOwner"), "privacy/hold", { ...hold, ...PW })).status, 404, "another academy cannot hold our player");
  const placed = await post(admin, "privacy/hold", { ...hold, ...PW });
  assert.equal(placed.status, 200, placed.text);
  const holdId = (placed.json as { id: string; blocked: number }).id;
  assert.equal((placed.json as { blocked: number }).blocked, 1, "the waiting request stops");
  const [h] = await db().select().from(t.legalHolds).where(eq(t.legalHolds.id, holdId));
  assert.deepEqual([h.createdBy, h.scope, h.playerId, h.releasedAt], [USERS.admin.id, "PLAYER", s.id, null]);
  assert.equal((await row(id)).status, "BLOCKED");
  await skipGrace(id);
  assert.equal((await runAll()).length, 0, "blocked requests never run");
  assert.equal((await db().select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 1);
  // Nothing new can be approved for a held player; a different player is not affected.
  assert.equal((await post(owner, "privacy/cancel", { id, reason: "Cancelling to try a new request." })).status, 200);
  const fresh = (await request(admin, s)).json as Req;
  assert.equal(code(await post(owner, "privacy/review", { id: fresh.id, version: fresh.version, decision: "APPROVE", reason: "Reviewed the preview carefully.", ...PW })), "LEGAL_HOLD");
  assert.ok(((fresh as unknown as { preview: { held: boolean } }).preview).held);
  const other = await approvedRequest(t2);
  await skipGrace(other);
  assert.equal((await runAll())[0].status, "COMPLETED", "partial eligibility: the hold is only for its own player");
  // Only the owner releases; the release is recorded and re-evaluates what it was blocking.
  assert.equal((await post(admin, "privacy/release", { id: holdId, reason: "The enquiry has concluded.", ...PW })).status, 403);
  assert.equal(code(await post(owner, "privacy/release", { id: holdId, reason: "x", ...PW })), "REASON_REQUIRED");
  assert.equal((await post(owner, "privacy/release", { id: holdId, reason: "The enquiry has concluded.", ownerPassword: "Wrong-Owner-Password-123" })).status, 403);
});
test("a released hold re-evaluates the blocked request: it goes back to review with a fresh preview and needs a new approval", async () => {
  await approve();
  const s = await seedSubject();
  const admin = await as("admin");
  const owner = await as("owner");
  const id = await approvedRequest(s);
  const hold = (await post(admin, "privacy/hold", { playerId: s.id, reason: "Pending a safeguarding enquiry by the governing body.", ...PW })).json as { id: string };
  assert.equal((await row(id)).status, "BLOCKED");
  const released = await post(owner, "privacy/release", { id: hold.id, reason: "The enquiry has concluded without findings.", ...PW });
  assert.equal(released.status, 200, released.text);
  assert.equal((released.json as { reevaluated: number }).reevaluated, 1);
  const after = await row(id);
  assert.deepEqual([after.status, after.reviewedBy, after.executeAfter, (after.plan as unknown[]).length], ["PREVIEW_READY", null, null, 0]);
  assert.equal(code(await post(owner, "privacy/release", { id: hold.id, reason: "Releasing it a second time over.", ...PW })), "ALREADY_RELEASED");
  const [h] = await db().select().from(t.legalHolds).where(eq(t.legalHolds.id, hold.id));
  assert.deepEqual([h.releasedBy, !!h.releasedAt, h.releaseReason], [USERS.owner.id, true, "The enquiry has concluded without findings."]);
  assert.equal((await db().select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 1, "releasing erases nothing by itself");
  // Approval again (by someone other than the requester) restarts the grace period.
  const again = await post(owner, "privacy/review", { id, version: after.version, decision: "APPROVE", reason: "Re-approved after the hold was released.", ...PW });
  assert.equal(again.status, 200, again.text);
  assert.equal((again.json as Req).status, "GRACE_PERIOD");
  // An academy-wide hold blocks every player until released.
  const academyHold = (await post(owner, "privacy/hold", { reason: "Regulator has asked for all records to be preserved.", ...PW })).json as { id: string };
  assert.equal((await row(id)).status, "BLOCKED");
  const t2 = await seedSubject();
  const req2 = (await request(admin, t2)).json as Req & { preview: { held: boolean } };
  assert.equal(req2.preview.held, true);
  await post(owner, "privacy/release", { id: academyHold.id, reason: "The regulator has confirmed it is finished.", ...PW });
  assert.equal((await row(id)).status, "PREVIEW_READY");
  assert.equal((await secEvents("LEGAL_HOLD_PLACED")).length >= 2 && (await secEvents("LEGAL_HOLD_RELEASED")).length >= 2, true);
});
test("a hold that appears while processing stops it between steps, and what was already done is reported (no silent partial)", async () => {
  await approve();
  const s = await seedSubject();
  const id = await approvedRequest(s);
  await skipGrace(id);
  // A hold appears in the middle of the run (created by a trigger when the report is erased).
  await db().execute(sql`create function p8_hold() returns trigger as $$ begin insert into legal_hold (id, academy_id, scope, player_id, reason, created_by) values ('p8-mid-' || old.player_id, old.academy_id, 'PLAYER', old.player_id, 'Hold placed in the middle of the run', 'someone') on conflict do nothing; return old; end $$ language plpgsql`);
  await db().execute(sql`create trigger p8_hold_trg after delete on player_report for each row execute function p8_hold()`);
  try {
    const out = await runAll();
    assert.equal(out[0].status, "BLOCKED");
  } finally {
    await db().execute(sql`drop trigger p8_hold_trg on player_report`);
    await db().execute(sql`drop function p8_hold()`);
  }
  const r = await row(id);
  assert.equal(r.status, "BLOCKED");
  assert.equal(r.blockedReason, "LEGAL_HOLD");
  const steps = r.steps as { category: string; status: string }[];
  const by = (k: string) => steps.find((x) => x.category === k)!.status;
  assert.deepEqual([by("MEDIA"), by("REPORTS"), by("NUTRITION"), by("PLAYER_PROFILE")], ["DONE", "DONE", "PENDING", "PENDING"], "what was done is reported; the rest was not done");
  assert.equal((await db().select().from(t.players).where(eq(t.players.id, s.id)))[0].name, s.name, "identity untouched while held");
  assert.equal((await db().select().from(t.nutritionPlans).where(eq(t.nutritionPlans.playerId, s.id))).length, 1);
  assert.ok((await events(id)).some((e) => e.event === "BLOCKED_BY_HOLD" && (e.detail as { at?: string }).at === "step"));
  assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 0, "not completed, so not in the ledger");
  assert.equal((await runAll()).length, 0, "and it does not resume while held");
});
test("concurrency: simultaneous approvals and duplicate requests are decided once; two runners never execute one request twice", async () => {
  await approve();
  const s = await seedSubject();
  const admin = await as("admin");
  const owner = await as("owner");
  // Duplicate requests at the same moment.
  const both = await Promise.all([admin.clone().post(`${API}/privacy/request`, { playerId: s.id, reason: WHY }), owner.clone().post(`${API}/privacy/request`, { playerId: s.id, reason: WHY })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const open = await db().select().from(t.erasureRequests).where(eq(t.erasureRequests.playerId, s.id));
  assert.equal(open.length, 1);
  const req = open[0];
  // The requester is whichever call won; the OTHER role approves, twice at once.
  const approver = req.requestedBy === USERS.admin.id ? owner : admin;
  const body = { id: req.id, version: req.version, decision: "APPROVE", reason: "Reviewed the preview and the written request.", ...PW };
  const decisions = await Promise.all([approver.clone().post(`${API}/privacy/review`, body), approver.clone().post(`${API}/privacy/review`, body), approver.clone().post(`${API}/privacy/review`, body)]);
  assert.equal(decisions.filter((r) => r.status === 200).length, 1, decisions.map((r) => r.status).join());
  assert.ok(decisions.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.equal((await events(req.id)).filter((e) => e.event === "APPROVED").length, 1);
  await skipGrace(req.id);
  // Two runners at once: one executes, the other finds it claimed.
  const [a, b] = await Promise.all([runRequest("green", req.id), runRequest("green", req.id)]);
  assert.ok([a.status, b.status].includes("COMPLETED"), `${a.status} / ${b.status}`);
  assert.ok([a, b].some((x) => x.note === "not claimed"), "the second runner found it claimed");
  assert.equal((await row(req.id)).status, "COMPLETED");
  assert.equal((await events(req.id)).filter((e) => e.event === "PROCESSING_STARTED").length, 1, "claimed once");
  assert.equal((await events(req.id)).filter((e) => e.event === "COMPLETED").length, 1);
  assert.equal((await readLedger(ledger)).filter((e) => e.requestId === req.id).length, 1, "one ledger line");
});
test("failure and recovery: a failing file store retries with backoff then fails explicitly; a failing step is reported and resumed; a dead runner's lock expires; a broken ledger never yields a silent success", async () => {
  await approve();
  const original = privateFiles.remove;
  // -- the file store is down: retried with backoff, never "done"
  let s = await seedSubject();
  let id = await approvedRequest(s);
  await skipGrace(id);
  privateFiles.remove = async () => {
    throw Object.assign(new Error("disk offline"), { code: "EIO" });
  };
  try {
    let now = new Date();
    assert.equal((await runAll(now))[0].status, "PROCESSING");
    let r = await row(id);
    assert.deepEqual([r.status, r.failureCode, r.attempts], ["PROCESSING", "STORAGE_PENDING", 1]);
    assert.ok(r.nextAttemptAt && r.nextAttemptAt.getTime() > now.getTime(), "backoff scheduled");
    assert.equal((await db().select().from(t.erasureRequests).where(eq(t.erasureRequests.id, id)))[0].completedAt, null);
    assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 0, "not complete, so not in the ledger");
    assert.equal(await fileExists(s.storageKey), true);
    assert.equal((await runAll(now)).length, 0, "not retried before its backoff has passed");
    // Come back later while it still fails, until it stops trying.
    for (let i = 0; i < MAX_ATTEMPTS + 2 && r.status === "PROCESSING"; i++) {
      now = new Date(now.getTime() + 3 * 3600_000);
      await runAll(now);
      r = await row(id);
    }
    assert.equal(r.status, "FAILED", "an explicit terminal failure");
    assert.ok(["STORAGE_FAILED", "STORAGE_PENDING"].includes(r.failureCode ?? ""));
    assert.ok((await secEvents("ERASURE_FAILED")).some((e) => (e.detail as { ref?: string }).ref === id));
    assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 0);
    assert.equal((await db().select().from(t.erasureRequests).where(eq(t.erasureRequests.id, id)))[0].status, "FAILED");
  } finally {
    privateFiles.remove = original;
  }
  // -- the file store comes back before the limit: completes
  s = await seedSubject();
  id = await approvedRequest(s);
  await skipGrace(id);
  privateFiles.remove = async () => {
    throw Object.assign(new Error("disk offline"), { code: "EIO" });
  };
  let now = new Date();
  try {
    await runAll(now);
  } finally {
    privateFiles.remove = original;
  }
  now = new Date(now.getTime() + 3 * 3600_000);
  assert.equal((await runAll(now))[0].status, "COMPLETED");
  assert.equal(await fileExists(s.storageKey), false);
  assert.equal((await db().select().from(t.storageDeletions).where(eq(t.storageDeletions.requestId, id)))[0].status, "DONE");
  // -- a step fails halfway: earlier steps stay done and are reported; the retry resumes, not restarts
  s = await seedSubject();
  id = await approvedRequest(s);
  await skipGrace(id);
  await db().execute(sql`alter table individual_goal rename to individual_goal_offline`);
  now = new Date();
  try {
    assert.equal((await runAll(now))[0].status, "PROCESSING");
  } finally {
    await db().execute(sql`alter table individual_goal_offline rename to individual_goal`);
  }
  let steps = (await row(id)).steps as { category: string; status: string; code?: string }[];
  assert.equal(steps.find((x) => x.category === "GOALS_AND_HISTORY")!.status, "FAILED");
  assert.equal(steps.find((x) => x.category === "MEDIA")!.status, "DONE");
  assert.equal(steps.find((x) => x.category === "PLAYER_PROFILE")!.status, "PENDING", "identity is erased last, so a failure never leaves a named empty shell");
  assert.equal((await db().select().from(t.players).where(eq(t.players.id, s.id)))[0].name, s.name);
  assert.ok((await events(id)).some((e) => e.event === "STEP_FAILED"));
  now = new Date(now.getTime() + 3 * 3600_000);
  assert.equal((await runAll(now))[0].status, "COMPLETED");
  assert.equal((await events(id)).filter((e) => e.event === "STEP_DONE" && (e.detail as { category?: string }).category === "MEDIA").length, 1, "the finished step was not repeated");
  // -- restart recovery: a runner died holding the lock
  s = await seedSubject();
  id = await approvedRequest(s);
  await skipGrace(id);
  await db().update(t.erasureRequests).set({ status: "PROCESSING", lockedBy: "dead-runner", lockedUntil: new Date(Date.now() + 600_000), attempts: 1 }).where(eq(t.erasureRequests.id, id));
  assert.equal((await runAll()).length, 0, "a live lock is respected");
  await db().update(t.erasureRequests).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(t.erasureRequests.id, id));
  assert.equal((await runAll())[0].status, "COMPLETED");
  assert.ok((await events(id)).some((e) => e.event === "RECOVERED"));
  // -- the external ledger cannot be written: retried, never a silent success
  s = await seedSubject();
  id = await approvedRequest(s);
  await skipGrace(id);
  const good = process.env.ERASURE_LEDGER_PATH;
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x");
  process.env.ERASURE_LEDGER_PATH = join(blocker, "ledger.jsonl");
  now = new Date();
  try {
    assert.equal((await runAll(now))[0].status, "PROCESSING");
  } finally {
    process.env.ERASURE_LEDGER_PATH = good;
  }
  assert.notEqual((await row(id)).status, "COMPLETED");
  now = new Date(now.getTime() + 3 * 3600_000);
  assert.equal((await runAll(now))[0].status, "COMPLETED");
  assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 1);
  // -- production without a ledger location refuses to erase
  const prod = process.env.NODE_ENV;
  s = await seedSubject();
  id = await approvedRequest(s);
  await skipGrace(id);
  delete process.env.ERASURE_LEDGER_PATH;
  (process.env as Record<string, string>).NODE_ENV = "production";
  try {
    assert.equal((await runAll())[0].status, "PROCESSING");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prod;
    process.env.ERASURE_LEDGER_PATH = good;
  }
  assert.equal((await row(id)).failureCode, "LEDGER_NOT_CONFIGURED");
  assert.equal((await processStorageDeletions({ requestId: id })).failed, 0);
});
test("restoring an older backup cannot silently bring erased data back: the external ledger finds it and, on request, erases it again", async () => {
  await approve();
  const s = await seedSubject();
  const q = db();
  // A copy of the database as it was BEFORE the erasure (what an old backup contains).
  const snap = {
    player: await q.select().from(t.players).where(eq(t.players.id, s.id)),
    profile: await q.select().from(t.profiles).where(eq(t.profiles.playerId, s.id)),
    link: await q.select().from(t.guardianLinks).where(eq(t.guardianLinks.playerId, s.id)),
    reports: await q.select().from(t.reports).where(eq(t.reports.playerId, s.id)),
    plans: await q.select().from(t.nutritionPlans).where(eq(t.nutritionPlans.playerId, s.id)),
    media: await q.select().from(t.mediaAssets).where(eq(t.mediaAssets.playerId, s.id)),
    revisions: await q.select().from(t.recordRevisions).where(inArray(t.recordRevisions.entityId, [s.reportId, s.planId, s.mediaId, s.id])),
    session: await q.select().from(t.trainingSessions).where(eq(t.trainingSessions.id, s.sessionId)),
    conversations: await q.select().from(t.conversations).where(eq(t.conversations.playerId, s.id)),
  };
  const id = await approvedRequest(s);
  await skipGrace(id);
  assert.equal((await runAll())[0].status, "COMPLETED");
  assert.equal((await reconcileFromLedger()).resurrected.filter((r) => r.playerId === s.id).length, 0, "nothing to correct while the erasure stands");
  // "Restore": put the old rows back, files included.
  await q.update(t.players).set({ name: snap.player[0].name }).where(eq(t.players.id, s.id));
  await q.update(t.profiles).set({ data: snap.profile[0].data }).where(eq(t.profiles.playerId, s.id));
  await q.update(t.guardianLinks).set({ active: true, relationship: "Mother" }).where(eq(t.guardianLinks.playerId, s.id));
  await q.insert(t.reports).values(snap.reports);
  await q.insert(t.nutritionPlans).values(snap.plans);
  await q.insert(t.mediaAssets).values(snap.media);
  await q.insert(t.recordRevisions).values(snap.revisions);
  await q.insert(t.conversations).values(snap.conversations);
  await q.update(t.trainingSessions).set({ data: snap.session[0].data }).where(eq(t.trainingSessions.id, s.sessionId));
  await privateFiles.put(s.storageKey, Buffer.from("restored-file"));
  assert.equal((await q.select().from(t.players).where(eq(t.players.id, s.id)))[0].name, s.name, "the person is back");
  // Report only: nothing changes, and the exit status of the command says there is something to do.
  const report = await reconcileFromLedger({ apply: false });
  const found = report.resurrected.find((r) => r.playerId === s.id)!;
  assert.ok(found);
  for (const c of ["MEDIA", "REPORTS", "NUTRITION", "CONVERSATIONS", "TRAINING_RECORDS", "GUARDIAN_LINKS", "PLAYER_PROFILE"]) assert.ok(found.categories.includes(c as never), c);
  assert.equal((await q.select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 1, "a report-only run changes nothing");
  // Apply: erased again, files too, recorded as a reconciliation.
  const applied = await reconcileFromLedger({ apply: true });
  assert.ok(applied.reapplied >= 1);
  assert.equal((await q.select().from(t.players).where(eq(t.players.id, s.id)))[0].name, "Erased player");
  assert.equal((await q.select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 0);
  assert.equal((await q.select().from(t.mediaAssets).where(eq(t.mediaAssets.playerId, s.id))).length, 0);
  assert.equal(await fileExists(s.storageKey), false);
  const recon = (await q.select().from(t.erasureRequests).where(and(eq(t.erasureRequests.playerId, s.id), eq(t.erasureRequests.source, "RECONCILIATION"))))[0];
  assert.equal(recon.status, "COMPLETED");
  assert.ok((await events(recon.id)).some((e) => e.event === "RECONCILED"));
  assert.equal((await reconcileFromLedger({ apply: true })).reapplied, 0, "and it is idempotent");
  // An erasure that never completed is NOT in the ledger and is never applied by it.
  const other = await seedSubject();
  const pending = await approvedRequest(other);
  void pending;
  const again = await reconcileFromLedger({ apply: true });
  assert.equal(again.resurrected.filter((r) => r.playerId === other.id).length, 0);
  assert.equal((await q.select().from(t.players).where(eq(t.players.id, other.id)))[0].name, other.name);
  // A damaged last line (crash while writing) does not hide the earlier entries.
  writeFileSync(ledger, readFileSync(ledger, "utf8") + '{"v":1,"requestId":"torn');
  assert.ok((await readLedger(ledger)).length >= 1);
});
test("eligibility: an approved time-based rule lists players whose period has elapsed; nothing is created or erased by it", async () => {
  const owner = await as("owner");
  await post(owner, "privacy/policy", { category: "MEDIA", decision: "APPROVE", action: "ERASE", retentionDays: 30, basis: BASIS, ...PW });
  const old = await seedSubject();
  const recent = await seedSubject();
  const active = await seedSubject();
  const at = (days: number) => new Date(Date.now() - days * 86_400_000);
  await db().update(t.recordRevisions).set({ createdAt: at(31) }).where(eq(t.recordRevisions.id, `rev-prof-${old.id}`));
  await db().update(t.recordRevisions).set({ createdAt: at(29) }).where(eq(t.recordRevisions.id, `rev-prof-${recent.id}`));
  await db().update(t.profiles).set({ data: { adult: false, birthDate: "", email: "", phone: "", notes: "", status: "ACTIVE", selfUserId: null, preferences: "" } }).where(eq(t.profiles.playerId, active.id));
  const before = (await db().select().from(t.erasureRequests)).length;
  const overview = (await owner.get(`${API}/privacy/overview`)).json as { eligible: { playerId: string; categories: string[] }[] };
  const ids = overview.eligible.map((e) => e.playerId);
  assert.ok(ids.includes(old.id), "31 days after leaving, 30-day rule");
  assert.ok(!ids.includes(recent.id), "29 days: not yet");
  assert.ok(!ids.includes(active.id), "an active player is never eligible");
  assert.deepEqual(overview.eligible.find((e) => e.playerId === old.id)!.categories, ["MEDIA"]);
  assert.equal((await db().select().from(t.erasureRequests)).length, before, "listing creates no request");
  assert.equal((await db().select().from(t.mediaAssets).where(eq(t.mediaAssets.playerId, old.id))).length, 1);
  // With no rule, nobody is eligible.
  await db().delete(t.retentionPolicies);
  assert.deepEqual(((await owner.get(`${API}/privacy/overview`)).json as { eligible: unknown[] }).eligible, []);
});
test("the previews and views reveal counts only, stay inside the academy, and are recorded in the access history", async () => {
  await approve();
  const s = await seedSubject();
  const owner = await as("owner");
  const admin = await as("admin");
  const req = (await request(admin, s)).json as Req;
  const before = (await db().select().from(t.accessEvents).where(and(eq(t.accessEvents.actorId, USERS.owner.id), eq(t.accessEvents.category, "PRIVACY"), eq(t.accessEvents.outcome, "SUCCESS")))).length;
  const detail = (await owner.get(`${API}/privacy/requests/${req.id}`)).json as Record<string, unknown>;
  const text = JSON.stringify(detail);
  for (const secret of [...Object.values(s.canary), s.name]) assert.ok(!text.includes(secret), `the preview leaked ${secret}`);
  await owner.get(`${API}/privacy/overview`);
  const after = await db().select().from(t.accessEvents).where(and(eq(t.accessEvents.actorId, USERS.owner.id), eq(t.accessEvents.category, "PRIVACY"), eq(t.accessEvents.outcome, "SUCCESS")));
  assert.equal(after.length, before + 2, "one event per read");
  assert.ok(after.some((e) => e.operation === "VIEW" && e.resourceId === req.id && e.playerId === s.id));
  for (const e of after) assert.ok(!JSON.stringify(e).includes(s.name));
  // Another academy's owner (and the other roles) cannot read this request by id; the refusal is recorded.
  assert.equal((await (await as("blueOwner")).get(`${API}/privacy/requests/${req.id}`)).status, 404);
  assert.equal((await (await as("coach")).get(`${API}/privacy/requests/${req.id}`)).status, 403);
  assert.equal((await (await as("guardian")).get(`${API}/privacy/requests/${req.id}`)).status, 403);
  assert.equal((await owner.get(`${API}/privacy/requests/no-such-request`)).status, 404);
  assert.ok((await db().select().from(t.accessEvents).where(and(eq(t.accessEvents.category, "PRIVACY"), eq(t.accessEvents.outcome, "DENIED")))).length >= 3);
  // The security log shows the milestones with references only.
  const log = (await owner.get(`${API}/security-events?event=ERASURE_REQUESTED`)).json as { events: { detail: Record<string, unknown> }[] };
  assert.ok(log.events.some((e) => e.detail.ref === req.id && Object.keys(e.detail).join() === "ref"));
});
test("database guarantees: one open request per player, valid states only, the schema matches the code", async () => {
  const s = await seedSubject();
  const names = (pattern: RegExp) => (err: unknown) => pattern.test(`${err} ${(err as { cause?: unknown }).cause}`);
  const base = { academyId: "green", playerId: s.id, source: "STAFF", reason: WHY, requestedBy: USERS.admin.id };
  await db().insert(t.erasureRequests).values({ ...base, id: "p8-one", status: "PREVIEW_READY" });
  await assert.rejects(() => db().insert(t.erasureRequests).values({ ...base, id: "p8-two", status: "GRACE_PERIOD" }), names(/erasure_request_one_open|unique|duplicate/i));
  await db().update(t.erasureRequests).set({ status: "CANCELLED" }).where(eq(t.erasureRequests.id, "p8-one"));
  await db().insert(t.erasureRequests).values({ ...base, id: "p8-three", status: "COMPLETED" });
  await db().insert(t.erasureRequests).values({ ...base, id: "p8-four", status: "PREVIEW_READY" });
  await assert.rejects(() => db().insert(t.erasureRequests).values({ ...base, id: "p8-five", status: "MAYBE" }), names(/check|erasure_request_status_check/i));
  await assert.rejects(() => db().insert(t.legalHolds).values({ id: "p8-h", academyId: "green", scope: "PLAYER", playerId: null, reason: WHY, createdBy: "x" }), names(/legal_hold_scope_check|check/i));
  await assert.rejects(() => db().insert(t.retentionPolicies).values({ academyId: "green", category: "REPORTS", action: "SHRED", basis: BASIS, approvedBy: "x" }), names(/check/i));
  await assert.rejects(() => db().insert(t.retentionPolicies).values({ academyId: "green", category: "REPORTS", action: "ERASE", retentionDays: -5, basis: BASIS, approvedBy: "x" }), names(/check/i));
  await db().update(t.erasureRequests).set({ status: "CANCELLED" }).where(eq(t.erasureRequests.id, "p8-four"));
});
test("erasure never crosses an academy: a player with the SAME id in another academy, and everything of theirs, is untouched", async () => {
  await approve();
  const s = await seedSubject();
  const q = db();
  // Ids are unique per academy, not globally: the blue academy has a player with this very id.
  const blueName = "Blue-Twin-Player";
  await q.insert(t.players).values({ id: s.id, academyId: "blue", name: blueName, batchId: "blue-batch" });
  await q.insert(t.profiles).values({ academyId: "blue", playerId: s.id, data: { adult: false, birthDate: "2014-01-01", email: "blue@example.test", phone: "blue-phone", notes: "blue-notes", status: "ACTIVE", selfUserId: null, preferences: "" } });
  await q.insert(t.reports).values({ id: `blue-rep-${s.id}`, academyId: "blue", playerId: s.id, version: 1, status: "PUBLISHED", data: { playerId: s.id, periodStart: "x", periodEnd: "y", title: "Blue", summary: "BLUE-REPORT", evidence: [], academyName: "b", playerName: blueName, reviewer: null, approvedAt: null } });
  await q.insert(t.goals).values({ id: `blue-goal-${s.id}`, academyId: "blue", playerId: s.id, data: { id: `blue-goal-${s.id}`, playerId: s.id, title: "BLUE-GOAL", method: "m", status: "ACTIVE" } as never });
  const blueRevision = { id: `blue-rev-${s.id}`, academyId: "blue", entityId: s.id, kind: "player-profile", version: 1, data: { name: blueName } };
  await q.insert(t.recordRevisions).values(blueRevision);
  const id = await approvedRequest(s);
  await skipGrace(id);
  assert.equal((await runAll())[0].status, "COMPLETED");
  assert.equal((await q.select().from(t.players).where(and(eq(t.players.academyId, "green"), eq(t.players.id, s.id))))[0].name, "Erased player");
  assert.equal((await q.select().from(t.players).where(and(eq(t.players.academyId, "blue"), eq(t.players.id, s.id))))[0].name, blueName);
  assert.equal((await q.select().from(t.profiles).where(and(eq(t.profiles.academyId, "blue"), eq(t.profiles.playerId, s.id))))[0].data.email, "blue@example.test");
  assert.equal((await q.select().from(t.reports).where(eq(t.reports.academyId, "blue"))).filter((r) => r.playerId === s.id).length, 1);
  assert.equal((await q.select().from(t.goals).where(eq(t.goals.academyId, "blue"))).filter((g) => g.playerId === s.id).length, 1);
  assert.equal((await q.select().from(t.recordRevisions).where(eq(t.recordRevisions.id, blueRevision.id))).length, 1);
  // The ledger reconciliation is scoped the same way.
  assert.equal((await reconcileFromLedger({ apply: true })).resurrected.filter((r) => r.playerId === s.id).length, 0);
  assert.equal((await q.select().from(t.players).where(and(eq(t.players.academyId, "blue"), eq(t.players.id, s.id))))[0].name, blueName);
});
test("a hold created behind the lifecycle's back is still honoured when processing starts", async () => {
  await approve();
  const s = await seedSubject();
  const id = await approvedRequest(s);
  await skipGrace(id);
  await db().insert(t.legalHolds).values({ id: `p8-direct-${s.id}`, academyId: "green", scope: "PLAYER", playerId: s.id, reason: "Inserted directly, not through the service", createdBy: "someone" });
  const out = await runAll();
  assert.deepEqual(out.map((o) => o.note), ["not claimed"]);
  const r = await row(id);
  assert.deepEqual([r.status, r.blockedReason], ["BLOCKED", "LEGAL_HOLD"]);
  assert.ok((await events(id)).some((e) => e.event === "BLOCKED_BY_HOLD" && (e.detail as { at?: string }).at === "claim"));
  assert.ok((await secEvents("ERASURE_BLOCKED")).some((e) => (e.detail as { ref?: string }).ref === id));
  assert.equal((await db().select().from(t.reports).where(eq(t.reports.playerId, s.id))).length, 1);
  assert.equal(await fileExists(s.storageKey), true);
});
test("retries are bounded: a step that keeps failing ends in an explicit FAILED after the maximum attempts, with the earlier steps reported", async () => {
  await approve();
  const s = await seedSubject();
  const id = await approvedRequest(s);
  await skipGrace(id);
  await db().execute(sql`alter table individual_goal rename to individual_goal_offline`);
  let now = new Date();
  let r = await row(id);
  try {
    for (let i = 0; i < MAX_ATTEMPTS + 3 && r.status !== "FAILED"; i++) {
      await runAll(now);
      now = new Date(now.getTime() + 3 * 3600_000);
      r = await row(id);
    }
  } finally {
    await db().execute(sql`alter table individual_goal_offline rename to individual_goal`);
  }
  assert.equal(r.status, "FAILED");
  assert.deepEqual([r.attempts, r.failureCode], [MAX_ATTEMPTS, "STEP_GOALS_AND_HISTORY"]);
  assert.equal((await events(id)).filter((e) => e.event === "RETRY_SCHEDULED").length, MAX_ATTEMPTS - 1);
  assert.ok((await secEvents("ERASURE_FAILED")).some((e) => (e.detail as { ref?: string }).ref === id));
  const by = (k: string) => (r.steps as { category: string; status: string }[]).find((x) => x.category === k)!.status;
  assert.deepEqual([by("MEDIA"), by("GOALS_AND_HISTORY"), by("PLAYER_PROFILE")], ["DONE", "FAILED", "PENDING"]);
  assert.equal((await db().select().from(t.players).where(eq(t.players.id, s.id)))[0].name, s.name, "identity is still there: nothing claims to be erased");
  assert.equal((await readLedger(ledger)).filter((e) => e.requestId === id).length, 0);
  assert.equal((await runAll(new Date(now.getTime() + 86_400_000))).length, 0, "a failed request is terminal; a new request is needed");
});
