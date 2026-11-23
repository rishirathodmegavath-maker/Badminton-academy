import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { linkGuardian } from "../src/modules/players/application/service";
import { recordWhatsAppOptIn } from "../src/modules/contacts/application/service";
import { config } from "../src/shared/config";
import { planDispatch, renderMessage, type PlanPlayer, type PlanReport } from "../src/modules/dispatch/domain/plan";
import { makeLinkToken, readLinkToken, reportLinkUrl } from "../src/modules/dispatch/link-token";
import { cancelDispatchBatch, dispatchBatchStatus, listDispatchBatches, previewDispatch, queueDispatch, retryFailedItems } from "../src/modules/dispatch/application/service";
import { BACKOFF_SECONDS, MAX_ATTEMPTS, processDispatchOnce } from "../src/modules/dispatch/application/worker";
import { applyProviderEvent } from "../src/modules/dispatch/application/events";
import { openReportLink } from "../src/modules/dispatch/application/report-links";
import { runQueueNowForTest } from "../src/modules/dispatch/application/dev";
import { TestEmailProvider, TestWhatsAppProvider } from "../src/modules/dispatch/providers/test-adapter";
import { MetaWhatsAppProvider, metaConfig, parseMetaWebhook, verifyMetaSignature } from "../src/modules/dispatch/providers/meta-whatsapp";
import { channelStates, providersFromEnv } from "../src/modules/dispatch/providers/registry";
import type { EmailProvider, SendOutcome, WhatsAppProvider } from "../src/modules/dispatch/providers/types";

process.env.BETTER_AUTH_SECRET = "isolated-dispatch-test-secret-12345678901234567";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * Bulk delivery of published reports: who is reached (parents, players, both), one message per parent with a secured link per
 * child, shared contacts reached once, the queue and its worker (retry, backoff, lease, no double send, suppression), what a
 * provider reports back, and who may open a link. No network and no real provider anywhere: only the test adapters and recorded
 * request shapes.
 */
let testDb: TestDatabase | undefined;
const actor = (id: string, role: string, academyId = "green"): Actor => ({ id, name: `Test ${id}`, role, academyId, timezone: "Asia/Kolkata", academyName: `Academy ${academyId}` });
const owner = actor("owner", "OWNER"),
  coach = actor("coach", "COACH"),
  blueOwner = actor("blue-owner", "OWNER", "blue");
const SECRET = process.env.BETTER_AUTH_SECRET!;
const reportId = (p: string) => `rep-${p}`;
const PLAYERS = [
  { id: "A", name: "Aadi Sharma", email: "", phone: "" },
  { id: "B", name: "Bina Sharma", email: "", phone: "" },
  { id: "C", name: "Chitra Das", email: "sunita@example.test", phone: "" },
  { id: "D", name: "Dev Kumar", email: "", phone: "" },
  { id: "E", name: "Esha Nair", email: "esha@example.test", phone: "+919800000005" },
  { id: "F", name: "Farah Khan", email: "", phone: "" },
] as const;
const PARENTS = [
  { id: "P1", name: "Priya Sharma", email: "priya@example.test", phone: "+919800000001", children: ["A", "B"] },
  { id: "P2", name: "Raj Sharma", email: "raj@example.test", phone: "+919800000001", children: ["A"] }, // the SAME number as Priya
  { id: "P3", name: "Sunita Das", email: "sunita@example.test", phone: null, children: ["C"] }, // the SAME e-mail as her daughter's profile
  { id: "P4", name: "Mohan Nair", email: "bounce-mohan@example.test", phone: "+919800000004", children: ["E"] },
] as const;
const reportData = (p: (typeof PLAYERS)[number], title = "March report") =>
  ({ playerId: p.id, periodStart: "2027-03-01", periodEnd: "2027-03-31", title, summary: "s", strengths: "s", improvements: "i", priorities: [], closingNote: "", evidence: [], academyName: "Academy green", playerName: p.name, reviewer: null, approvedAt: null }) as never;

before(async () => {
  testDb = await provisionTestDatabase("dispatch");
  const db = database();
  for (const id of ["green", "blue"]) {
    await db.insert(t.academies).values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
    await db.insert(t.academySettings).values({ academyId: id, data: defaultSettings });
    await db.insert(t.entitlements).values({ academyId: id, data: { reports: true, nutrition: true, communications: true, manualVideo: true } });
    await db.insert(t.branches).values({ id: `${id}-branch`, academyId: id, name: "Test branch" });
  }
  for (const a of [owner, coach, blueOwner]) {
    await db.insert(t.user).values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db.insert(t.memberships).values({ academyId: a.academyId, userId: a.id, role: a.role });
  }
  await db.insert(t.batches).values({ id: "green-batch", academyId: "green", coachId: "coach", branchId: "green-branch", name: "Under 13" });
  for (const p of PLAYERS) {
    await db.insert(t.players).values({ id: p.id, academyId: "green", batchId: "green-batch", name: p.name });
    await db.insert(t.profiles).values({ academyId: "green", playerId: p.id, data: { ...defaultProfile, status: "ACTIVE", email: p.email, phone: p.phone } });
    // F's report is still a draft: it must never be delivered. Everyone else's is published.
    await db.insert(t.reports).values({ id: reportId(p.id), academyId: "green", playerId: p.id, status: p.id === "F" ? "DRAFT" : "PUBLISHED", version: 2, data: reportData(p) });
  }
  for (const g of PARENTS) {
    await db.insert(t.user).values({ id: g.id, name: g.name, email: g.email === "sunita@example.test" ? "sunita-login@example.test" : g.email, phone: g.phone });
    await db.insert(t.memberships).values({ academyId: "green", userId: g.id, role: "GUARDIAN" });
    for (const child of g.children) await linkGuardian(owner, { playerId: child, userId: g.id, relationship: "Parent", active: true });
  }
  // Sunita's login e-mail differs from her daughter's profile e-mail on purpose in the user table (unique logins); the plan reads the
  // account e-mail, so make the shared value explicit by giving her account the same value as the profile.
  await db.update(t.user).set({ email: "sunita@example.test" }).where(eq(t.user.id, "P3"));
  // WhatsApp opt-in: Priya and Raj (who share ONE number) both opted in; Esha's own number is opted in; Mohan has not.
  await recordWhatsAppOptIn(owner, { playerId: "A", userId: "P1", source: "OWNER_WRITTEN" });
  await recordWhatsAppOptIn(owner, { playerId: "A", userId: "P2", source: "OWNER_WRITTEN" });
  await recordWhatsAppOptIn(owner, { playerId: "E", source: "PARENT_FORM" });
});
after(async () => {
  await testDb?.cleanup();
});
const ALL = ["A", "B", "C", "D", "E"].map(reportId);
const sel = (over: Record<string, unknown> = {}) => ({ reportIds: ALL, mode: "PARENTS", channels: ["EMAIL", "WHATSAPP"], consolidation: "PER_PARENT", ...over });
const refused = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { status?: number; code?: string; message?: string });
const items = async (batchId: string) => database().select().from(t.dispatchItems).where(eq(t.dispatchItems.batchId, batchId));
const itemFor = (rows: Awaited<ReturnType<typeof items>>, who: string, channel: string) => rows.find((i) => i.channel === channel && i.recipientNames.some((n) => n.startsWith(who)));
const bothProviders = () => ({ EMAIL: new TestEmailProvider(), WHATSAPP: new TestWhatsAppProvider() });
// An hour ahead, so everything the tests queue is already due when a worker pass runs at NOW.
const NOW = new Date(Date.now() + 3_600_000);

test("the pure plan: one message per parent with a link per child; shared contacts reached once; every skip has a reason", () => {
  const reports: PlanReport[] = [
    { id: "ra", playerId: "a", title: "T", childFirstName: "Aadi" },
    { id: "rb", playerId: "b", title: "T", childFirstName: "Bina" },
  ];
  const guard = (userId: string, name: string, email: string | null, phone: string | null) => ({ userId, name, email, phone });
  const players: PlanPlayer[] = [
    { id: "a", name: "Aadi Sharma", email: null, phone: null, phoneUnreadable: false, guardians: [guard("p1", "Priya Sharma", "p@x.test", "+919800000001")] },
    { id: "b", name: "Bina Sharma", email: "p@x.test", phone: "+919800000001", phoneUnreadable: false, guardians: [guard("p1", "Priya Sharma", "p@x.test", "+919800000001")] },
  ];
  const flags = () => ({ optedIn: true, suppressed: false });
  const parents = planDispatch({ reports, players, mode: "PARENTS", channels: ["EMAIL"], consolidation: "PER_PARENT", flags });
  assert.equal(parents.items.length, 1, "two children, one parent, one message");
  assert.deepEqual(parents.items[0].reportIds.sort(), ["ra", "rb"]);
  const perChild = planDispatch({ reports, players, mode: "PARENTS", channels: ["EMAIL"], consolidation: "PER_CHILD", flags });
  assert.equal(perChild.items.length, 2, "per-child mode: one message per child");
  assert.deepEqual(perChild.items.map((i) => i.reportIds.length), [1, 1]);
  const both = planDispatch({ reports, players, mode: "BOTH", channels: ["EMAIL", "WHATSAPP"], consolidation: "PER_PARENT", flags });
  const mail = both.items.filter((i) => i.channel === "EMAIL");
  assert.equal(mail.length, 1, "Bina's own e-mail equals her parent's: the same address is reached once");
  assert.equal(mail[0].recipientNames.length, 2);
  assert.equal(both.sharedAddress, 2, "e-mail and WhatsApp each reached a shared address once");
  assert.ok(both.skipped.some((s) => s.recipientKind === "PLAYER" && s.recipientName === "Aadi Sharma" && s.reason === "NO_CONTACT"), "a player with no contact is listed, not dropped");
  const none = planDispatch({ reports, players, mode: "PARENTS", channels: ["WHATSAPP"], consolidation: "PER_PARENT", flags: () => ({ optedIn: false, suppressed: false }) });
  assert.deepEqual([none.items.length, ...new Set(none.skipped.map((s) => s.reason))], [0, "NOT_OPTED_IN"]);
  const suppressed = planDispatch({ reports, players, mode: "PARENTS", channels: ["EMAIL"], consolidation: "PER_PARENT", flags: () => ({ optedIn: true, suppressed: true }) });
  assert.deepEqual(suppressed.skipped.map((s) => s.reason), ["SUPPRESSED"]);
  const orphan = planDispatch({ reports, players: [{ ...players[0], guardians: [] }], mode: "PARENTS", channels: ["EMAIL"], consolidation: "PER_PARENT", flags });
  assert.deepEqual(orphan.skipped.map((s) => s.reason), ["NO_PARENT"]);
  // the words: one link per child, only the children of THIS message, no report content, players told a parent must open it
  const m = renderMessage({ academyName: "Academy", recipientNames: ["Priya Sharma"], children: [{ childFirstName: "Aadi", title: "T", url: "https://x/l#1" }, { childFirstName: "Bina", title: "T", url: "https://x/l#2" }], forPlayerOnly: false });
  assert.match(m.text, /Hello Priya,/);
  assert.match(m.text, /Aadi: https:\/\/x\/l#1\nBina: https:\/\/x\/l#2/);
  assert.equal(m.subject, "Aadi and Bina: development reports");
  assert.deepEqual(m.templateParams, ["Priya", "Aadi and Bina", "Aadi: https://x/l#1 | Bina: https://x/l#2"]);
  assert.ok(m.templateParams.every((p) => !/\n/.test(p)), "template variables are single-line");
  const solo = renderMessage({ academyName: "Academy", recipientNames: ["Aadi Sharma"], children: [{ childFirstName: "Aadi", title: "T", url: "https://x/l#1" }], forPlayerOnly: true });
  assert.match(solo.text, /A parent or guardian opens it by signing in/);
});

test("link tokens cannot be forged or altered, and carry nothing secret", () => {
  const id = "0b9f8f3e-6d57-4a43-8d3a-5c1f4f6b2a11";
  const token = makeLinkToken(SECRET, id);
  assert.equal(readLinkToken(SECRET, token), id);
  assert.equal(readLinkToken(SECRET, `${token}x`), null, "altered");
  assert.equal(readLinkToken(SECRET, `${id}.AAAA`), null, "made up");
  assert.equal(readLinkToken("another-secret-another-secret-another-secret", token), null, "another server's token");
  assert.equal(readLinkToken(SECRET, "not-a-token"), null);
  assert.equal(readLinkToken(SECRET, undefined), null);
  assert.equal(reportLinkUrl("https://academy.example/", token), `https://academy.example/report-link#${token}`, "the token is in the fragment");
});

test("preview shows who is reached and who is left out and why; approve-and-queue is owner-level, queues without sending, and cannot double-send", async () => {
  const p = await previewDispatch(owner, sel());
  assert.equal(p.reports, 5, "five published reports; the draft was never selected");
  assert.equal(p.notPublished, 0, "F was never selected");
  assert.deepEqual(p.byChannel, { EMAIL: 4, WHATSAPP: 1 }, "four parents by e-mail; Priya and Raj share one number, so one WhatsApp message");
  assert.equal(p.sharedAddress, 1);
  const reasons = (who: string, channel: string) => p.skipped.filter((s) => s.recipient.startsWith(who) && s.channel === channel).map((s) => s.reason);
  assert.deepEqual(reasons("Sunita", "WHATSAPP"), ["NO_CONTACT"]);
  assert.deepEqual(reasons("Mohan", "WHATSAPP"), ["NOT_OPTED_IN"]);
  assert.deepEqual(p.skipped.filter((s) => s.kind === "CHILD").map((s) => [s.recipient, s.reason]).sort(), [["Dev Kumar", "NO_PARENT"], ["Dev Kumar", "NO_PARENT"]]);
  assert.equal(p.sample.length, 3);
  assert.ok(p.sample.every((s) => /…|\*\*\*/.test(s.to)), "addresses are masked in the preview");
  assert.ok(p.sample.every((s) => !s.text.includes("report-link#0") && s.text.includes("a private link")), "no real token in a preview");
  const both = await previewDispatch(owner, sel({ mode: "BOTH" }));
  assert.deepEqual(both.byChannel, { EMAIL: 5, WHATSAPP: 2 }, "Esha's own contacts add two messages; Chitra's e-mail equals her parent's, so it is reached once");
  assert.equal(both.sharedAddress, 2);
  const players = await previewDispatch(owner, sel({ mode: "PLAYERS" }));
  assert.deepEqual(players.byChannel, { EMAIL: 2, WHATSAPP: 1 }, "players only: Chitra and Esha by e-mail, Esha by WhatsApp");
  assert.ok(players.skipped.some((s) => s.recipient === "Aadi Sharma" && s.reason === "NO_CONTACT"));
  // a draft is excluded, not delivered
  const withDraft = await previewDispatch(owner, sel({ reportIds: [...ALL, reportId("F")] }));
  assert.equal(withDraft.notPublished, 1);
  // authority: a coach may preview their players, not approve; another academy sees nothing of ours
  assert.equal((await refused(queueDispatch(coach, sel())))?.status, 403);
  assert.equal((await refused(previewDispatch(blueOwner, sel())))?.status, 404, "another academy's reports are not found");
  // queue
  const q = await queueDispatch(owner, { ...sel(), title: "March reports" });
  assert.deepEqual([q.queued, q.skipped > 0], [5, true]);
  const rows = await items(q.batchId);
  const queued = rows.filter((r) => r.status === "QUEUED");
  assert.equal(queued.length, 5, "queued, nothing sent");
  assert.equal(rows.filter((r) => r.status === "SKIPPED").every((r) => r.skipReason && r.address === "" || r.skipReason), true, "the people left out are recorded with a reason");
  assert.deepEqual(itemFor(rows, "Priya", "EMAIL")!.reportIds.sort(), [reportId("A"), reportId("B")], "one message, both children");
  assert.deepEqual(itemFor(rows, "Raj", "EMAIL")!.reportIds, [reportId("A")], "Raj's message carries only Aadi's report");
  const wa = itemFor(rows, "Priya", "WHATSAPP")!;
  assert.deepEqual(wa.recipientNames.sort(), ["Priya Sharma", "Raj Sharma"], "the shared number is one message to both");
  const links = await database().select().from(t.reportLinks);
  assert.equal(links.length, queued.reduce((n, r) => n + r.reportIds.length, 0), "one individually secured link per child per message");
  assert.ok(links.every((l) => l.expiresAt.getTime() > Date.now() + 29 * 86_400_000));
  const [batch] = await database().select().from(t.dispatchBatches).where(eq(t.dispatchBatches.id, q.batchId));
  assert.deepEqual([batch.status, batch.approvedBy], ["APPROVED", "owner"]);
  // the same selection again sends nothing new: everything is already queued
  const again = await refused(queueDispatch(owner, sel()));
  assert.equal(again?.code, "NOTHING_TO_SEND");
  assert.match(again?.message ?? "", /already/);
  const audit = await database().select().from(t.audit).where(eq(t.audit.action, "dispatch-approve"));
  assert.ok(audit.length >= 1 && !JSON.stringify(audit).includes("@example.test"), "the audit line carries counts, never an address");
  // the screen's reads
  const listed = await listDispatchBatches(owner);
  assert.equal(listed.batches[0].counts.QUEUED, 5);
  const status = await dispatchBatchStatus(owner, { batchId: q.batchId });
  assert.ok(status.items.every((i) => i.to === "" || /\*\*\*|…/.test(i.to)) && !JSON.stringify(status).includes("priya@"), "addresses are masked on screen");
});

test("the worker sends each queued message exactly once, with one secured link per child, and tracks every outcome", async () => {
  const [batch] = await database().select().from(t.dispatchBatches);
  const providers = bothProviders();
  const s = await processDispatchOnce({ providers, now: NOW, workerId: "w1" });
  assert.equal(s.claimed, 5);
  const rows = await items(batch.id);
  // Mohan's address bounces; every other message is accepted
  assert.equal(rows.filter((r) => r.status === "SENT").length, 4);
  const mohan = itemFor(rows, "Mohan", "EMAIL")!;
  assert.deepEqual([mohan.status, mohan.lastErrorCode], ["FAILED", "TEST_BOUNCED"]);
  const priya = providers.EMAIL.sent.find((m) => m.to === "priya@example.test")!;
  const urls = priya.text.match(/http:\/\/127\.0\.0\.1:3100\/report-link#[^\s]+/g) ?? [];
  assert.equal(urls.length, 2, "two children, two links");
  assert.equal(new Set(urls).size, 2, "each link is its own");
  assert.match(priya.text, /Aadi: .*\nBina: /);
  assert.equal(priya.subject, "Aadi and Bina: development reports");
  assert.ok(!/Chitra|Esha|Dev/.test(priya.text), "never another family's child");
  const raj = providers.EMAIL.sent.find((m) => m.to === "raj@example.test")!;
  assert.ok(!/Bina/.test(raj.text) && /Aadi/.test(raj.text));
  const waMessage = providers.WHATSAPP.sent[0];
  assert.equal(waMessage.to, "+919800000001");
  assert.equal(providers.WHATSAPP.sent.length, 1, "the shared number received exactly one message");
  // the stored link ids are what the message carries
  for (const u of urls) assert.ok(readLinkToken(SECRET, u.split("#")[1]), "a valid, unforged token");
  // a second pass sends nothing more
  const again = await processDispatchOnce({ providers, now: NOW, workerId: "w1" });
  assert.equal(again.claimed, 0);
  assert.equal(providers.EMAIL.sent.length + providers.WHATSAPP.sent.length, 5 - 1, "four accepted messages in all");
  // a bounce suppresses the address for THAT parent, and only for the people the message was for
  const [point] = await database().select().from(t.contactPoints).where(and(eq(t.contactPoints.userId, "P4"), eq(t.contactPoints.channel, "EMAIL")));
  assert.equal(point.suppressionReason, "BOUNCED");
  const events = await database().select().from(t.dispatchEvents).where(eq(t.dispatchEvents.itemId, priya ? itemFor(rows, "Priya", "EMAIL")!.id : ""));
  assert.equal(events.length, 1, "the hand-over to the provider is recorded");
  // retry: a suppressed address is NOT retried; nothing else is touched
  const retry = await retryFailedItems(owner, { batchId: batch.id });
  assert.deepEqual(retry, { requeued: 0, stillBlocked: 1 });
  assert.equal((await items(batch.id)).filter((r) => r.status === "SENT").length, 4, "retry never touches what was sent");
});

test("a later selection is blocked by the suppression too: the plan names it and queues nothing for that address", async () => {
  const p = await previewDispatch(owner, sel({ reportIds: [reportId("E")], channels: ["EMAIL"] }));
  assert.equal(p.messages, 0);
  assert.deepEqual(p.skipped.map((s) => s.reason), ["SUPPRESSED"]);
});

test("transient failures retry with a growing delay and then succeed; permanent ones stop; after the last attempt it fails", async () => {
  await database().update(t.user).set({ email: "flaky-parent@example.test" }).where(eq(t.user.id, "P3"));
  await database().update(t.profiles).set({ data: { ...defaultProfile, status: "ACTIVE", email: "", phone: "" } }).where(and(eq(t.profiles.playerId, "C"), eq(t.profiles.academyId, "green")));
  const q = await queueDispatch(owner, sel({ reportIds: [reportId("C")], channels: ["EMAIL"] }));
  const providers = bothProviders();
  let at = new Date(NOW.getTime() + 10 * 60_000);
  const item = async () => (await items(q.batchId)).find((i) => i.status !== "SKIPPED")!;
  await processDispatchOnce({ providers, now: at, workerId: "w" });
  let row = await item();
  assert.deepEqual([row.status, row.attempts, row.lastErrorCode], ["FAILED_RETRYABLE", 1, "TEST_TEMPORARY"]);
  assert.ok(row.nextAttemptAt.getTime() >= at.getTime() + BACKOFF_SECONDS[0] * 1000 - 1000, "waits before trying again");
  const early = await processDispatchOnce({ providers, now: new Date(at.getTime() + 5_000), workerId: "w" });
  assert.equal(early.claimed, 0, "not yet due");
  at = new Date(at.getTime() + 10 * 60_000);
  await processDispatchOnce({ providers, now: at, workerId: "w" });
  row = await item();
  assert.deepEqual([row.status, row.attempts], ["FAILED_RETRYABLE", 2]);
  assert.ok(row.nextAttemptAt.getTime() >= at.getTime() + BACKOFF_SECONDS[1] * 1000 - 1000, "the delay grows");
  at = new Date(at.getTime() + 60 * 60_000);
  await processDispatchOnce({ providers, now: at, workerId: "w" });
  row = await item();
  assert.deepEqual([row.status, row.attempts, row.lastErrorCode], ["SENT", 3, null], "the third attempt succeeds, recorded once");
  assert.equal(providers.EMAIL.sent.filter((m) => m.to === "flaky-parent@example.test").length, 1, "one message, however many attempts");
  // retries run out: a provider that always fails temporarily ends FAILED after the maximum attempts
  const always: EmailProvider = { name: "always-down", send: async (): Promise<SendOutcome> => ({ ok: false, retryable: true, errorCode: "DOWN" }) };
  await database().update(t.user).set({ email: "down-parent@example.test" }).where(eq(t.user.id, "P3"));
  await database().update(t.profiles).set({ data: { ...defaultProfile, status: "ACTIVE", email: "", phone: "" } }).where(and(eq(t.profiles.playerId, "C"), eq(t.profiles.academyId, "green")));
  await database().update(t.dispatchItems).set({ status: "CANCELLED" }).where(eq(t.dispatchItems.batchId, q.batchId));
  // a fresh report for Chitra so the "already sent" rule does not apply
  await database().insert(t.reports).values({ id: "rep-C2", academyId: "green", playerId: "C", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[2], "April report") });
  const q2 = await queueDispatch(owner, sel({ reportIds: ["rep-C2"], channels: ["EMAIL"] }));
  let when = new Date(at.getTime() + 3_600_000);
  for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
    await processDispatchOnce({ providers: { EMAIL: always }, now: when, workerId: "w" });
    when = new Date(when.getTime() + 24 * 3_600_000);
  }
  const done = (await items(q2.batchId)).find((i) => i.status !== "SKIPPED")!;
  assert.deepEqual([done.status, done.attempts, done.lastErrorCode], ["FAILED", MAX_ATTEMPTS, "DOWN"]);
  // retry puts it back with a fresh set of attempts, and a working provider then sends it
  const retried = await retryFailedItems(owner, { batchId: q2.batchId });
  assert.equal(retried.requeued, 1);
  const ok = bothProviders();
  await processDispatchOnce({ providers: ok, now: when, workerId: "w" });
  assert.equal((await items(q2.batchId)).find((i) => i.status !== "SKIPPED")!.status, "SENT");
  assert.equal(ok.EMAIL.sent.length, 1);
});

test("two workers at once never send the same message twice; a dead worker's message is recovered after its lease; an unconfigured channel waits", async () => {
  await database().insert(t.reports).values([
    { id: "rep-A2", academyId: "green", playerId: "A", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[0], "April report") },
    { id: "rep-B2", academyId: "green", playerId: "B", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[1], "April report") },
  ]);
  const q = await queueDispatch(owner, sel({ reportIds: ["rep-A2", "rep-B2"] }));
  const rows = await items(q.batchId);
  const queued = rows.filter((r) => r.status === "QUEUED").length;
  assert.ok(queued >= 3);
  // an unconfigured channel: only e-mail has a provider, so WhatsApp items are not touched
  const emailOnly = { EMAIL: new TestEmailProvider() };
  await processDispatchOnce({ providers: emailOnly, now: NOW, workerId: "e", batchSize: 1 });
  assert.ok((await items(q.batchId)).some((r) => r.channel === "WHATSAPP" && r.status === "QUEUED" && r.attempts === 0), "no WhatsApp provider, no WhatsApp attempt");
  // a worker that died holding an item: the lease runs out and it is recovered
  const stuck = (await items(q.batchId)).find((r) => r.status === "QUEUED")!;
  await database().update(t.dispatchItems).set({ status: "SENDING", leasedBy: "dead", leaseUntil: new Date(NOW.getTime() - 1000), attempts: 1 }).where(eq(t.dispatchItems.id, stuck.id));
  const a = bothProviders();
  const b = bothProviders();
  const [x, y] = await Promise.all([
    processDispatchOnce({ providers: a, now: NOW, workerId: "a", batchSize: 2 }),
    processDispatchOnce({ providers: b, now: NOW, workerId: "b", batchSize: 2 }),
  ]);
  void x;
  void y;
  await processDispatchOnce({ providers: a, now: NOW, workerId: "a" });
  const after = await items(q.batchId);
  assert.ok(after.filter((r) => r.status !== "SKIPPED").every((r) => ["SENT", "FAILED"].includes(r.status)), "every item finished");
  const sentAddresses = [...a.EMAIL.sent, ...b.EMAIL.sent, ...emailOnly.EMAIL.sent, ...a.WHATSAPP.sent, ...b.WHATSAPP.sent].map((m) => `${m.channel}|${m.to}`);
  assert.equal(new Set(sentAddresses).size, sentAddresses.length, "no address received the same message twice");
  const recovered = after.find((r) => r.id === stuck.id)!;
  assert.equal(recovered.status, "SENT", "the dead worker's message was recovered and sent");
});

test("a withdrawn report is left out at the moment of sending, and a message with nothing left is skipped", async () => {
  await database().insert(t.reports).values([
    { id: "rep-A3", academyId: "green", playerId: "A", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[0], "May report") },
    { id: "rep-B3", academyId: "green", playerId: "B", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[1], "May report") },
  ]);
  const q = await queueDispatch(owner, sel({ reportIds: ["rep-A3", "rep-B3"], channels: ["EMAIL"] }));
  await database().update(t.reports).set({ status: "WITHDRAWN" }).where(eq(t.reports.id, "rep-B3"));
  const providers = bothProviders();
  await processDispatchOnce({ providers, now: NOW, workerId: "w" });
  const priya = providers.EMAIL.sent.find((m) => m.to === "priya@example.test")!;
  assert.match(priya.text, /Aadi/);
  assert.ok(!/Bina/.test(priya.text), "the withdrawn report is not in the message");
  assert.equal(priya.text.match(/report-link#/g)?.length, 1);
  await database().update(t.reports).set({ status: "WITHDRAWN" }).where(eq(t.reports.id, "rep-A3"));
  // a new batch for a report that is withdrawn before sending: nothing left, so the message is skipped, not sent
  await database().insert(t.reports).values({ id: "rep-A4", academyId: "green", playerId: "A", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[0], "June report") });
  const q2 = await queueDispatch(owner, sel({ reportIds: ["rep-A4"], channels: ["EMAIL"] }));
  await database().update(t.reports).set({ status: "WITHDRAWN" }).where(eq(t.reports.id, "rep-A4"));
  const p2 = bothProviders();
  await processDispatchOnce({ providers: p2, now: NOW, workerId: "w" });
  assert.equal(p2.EMAIL.sent.length, 0);
  const skipped = (await items(q2.batchId)).filter((r) => r.status === "SKIPPED" && /REPORT_WITHDRAWN/.test(r.skipReason ?? ""));
  assert.ok(skipped.length >= 1);
  void q;
});

test("cancelling a batch stops what has not been sent and kills its links; a worker then sends nothing for it", async () => {
  await database().insert(t.reports).values({ id: "rep-C5", academyId: "green", playerId: "C", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[2], "July report") });
  await database().update(t.user).set({ email: "sunita@example.test" }).where(eq(t.user.id, "P3"));
  const q = await queueDispatch(owner, sel({ reportIds: ["rep-C5"], channels: ["EMAIL"] }));
  assert.equal((await refused(cancelDispatchBatch(coach, { batchId: q.batchId })))?.status, 403);
  const c = await cancelDispatchBatch(owner, { batchId: q.batchId });
  assert.equal(c.stopped, 1);
  const providers = bothProviders();
  await processDispatchOnce({ providers, now: NOW, workerId: "w" });
  assert.equal(providers.EMAIL.sent.length, 0, "nothing is sent for a cancelled batch");
  const links = await database().select().from(t.reportLinks).where(eq(t.reportLinks.reportId, "rep-C5"));
  assert.ok(links.length && links.every((l) => l.revokedAt), "its links are revoked");
  assert.equal((await refused(retryFailedItems(owner, { batchId: q.batchId })))?.status, 409, "a cancelled batch cannot be retried");
});

test("provider reports: delivered and read move a message forward only, repeats change nothing, a complaint or STOP suppresses", async () => {
  const [item] = (await database().select().from(t.dispatchItems).where(eq(t.dispatchItems.status, "SENT"))).filter((i) => i.channel === "EMAIL");
  const base = { kind: "status" as const, provider: "test", providerMessageId: item.providerMessageId!, occurredAt: new Date(), detail: "" };
  const status = async () => (await database().select().from(t.dispatchItems).where(eq(t.dispatchItems.id, item.id)))[0];
  assert.equal(await applyProviderEvent({ ...base, eventId: "e1", type: "DELIVERED" }), "APPLIED");
  assert.equal((await status()).status, "DELIVERED");
  assert.ok((await status()).deliveredAt);
  assert.equal(await applyProviderEvent({ ...base, eventId: "e1", type: "DELIVERED" }), "DUPLICATE", "a repeated event changes nothing");
  assert.equal(await applyProviderEvent({ ...base, eventId: "e2", type: "SENT" }), "APPLIED");
  assert.equal((await status()).status, "DELIVERED", "a late 'sent' does not undo 'delivered'");
  assert.equal(await applyProviderEvent({ ...base, eventId: "e3", type: "FAILED" }), "APPLIED");
  assert.equal((await status()).status, "DELIVERED", "a failure after delivery does not take the delivery back");
  assert.equal(await applyProviderEvent({ ...base, eventId: "e4", type: "READ" }), "APPLIED");
  assert.equal((await status()).status, "READ");
  assert.equal(await applyProviderEvent({ ...base, eventId: "e5", type: "DELIVERED" }), "APPLIED");
  assert.equal((await status()).status, "READ", "never moves back from read");
  assert.equal(await applyProviderEvent({ ...base, providerMessageId: "no-such-message", eventId: "e6", type: "DELIVERED" }), "UNKNOWN_MESSAGE");
  // a complaint suppresses for the people the message was for
  const [other] = (await database().select().from(t.dispatchItems).where(eq(t.dispatchItems.status, "SENT"))).filter((i) => i.channel === "EMAIL" && i.id !== item.id);
  assert.equal(await applyProviderEvent({ kind: "status", provider: "test", eventId: "c1", providerMessageId: other.providerMessageId!, type: "COMPLAINED", occurredAt: new Date(), detail: "" }), "APPLIED");
  const suppressed = await database().select().from(t.contactPoints).where(and(eq(t.contactPoints.address, other.address), eq(t.contactPoints.channel, "EMAIL")));
  assert.ok(suppressed.length >= 1 && suppressed.every((s) => s.suppressionReason === "COMPLAINED"));
  // a STOP from a WhatsApp number withdraws the opt-in and suppresses it
  assert.equal(await applyProviderEvent({ kind: "stop", provider: "meta", eventId: "m1", address: "+919800000001", occurredAt: new Date() }), "STOP_APPLIED");
  const stopped = await database().select().from(t.contactPoints).where(and(eq(t.contactPoints.address, "+919800000001"), eq(t.contactPoints.channel, "WHATSAPP")));
  assert.ok(stopped.length >= 2 && stopped.every((s) => s.suppressionReason === "STOP" && s.optInRevokedAt));
  const after = await previewDispatch(owner, sel({ reportIds: [reportId("A")], channels: ["WHATSAPP"] }));
  assert.equal(after.byChannel.WHATSAPP, 0, "a number that said STOP is not messaged again");
});

test("a report link opens only for a signed-in, active parent of THAT child, while the link is live and the report is published", async () => {
  await database().update(t.contactPoints).set({ suppressedAt: null, suppressionReason: null }).where(eq(t.contactPoints.channel, "EMAIL"));
  await database().insert(t.reports).values({ id: "rep-L", academyId: "green", playerId: "B", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[1], "Link report") });
  await database().insert(t.reports).values({ id: "rep-LA", academyId: "green", playerId: "A", status: "PUBLISHED", version: 2, data: reportData(PLAYERS[0], "Link report") });
  const q = await queueDispatch(owner, sel({ reportIds: ["rep-L", "rep-LA"], channels: ["EMAIL"] }));
  const [item] = (await items(q.batchId)).filter((i) => i.recipientNames.includes("Priya Sharma"));
  const linkOf = async (report: string) => {
    const [l] = await database().select().from(t.reportLinks).where(and(eq(t.reportLinks.itemId, item.id), eq(t.reportLinks.reportId, report)));
    return { row: l, token: makeLinkToken(SECRET, l.id) };
  };
  const forB = await linkOf("rep-L");
  const opened = await openReportLink({ id: "P1" }, forB.token);
  assert.deepEqual([opened.reportId, opened.childFirstName, opened.academyId], ["rep-L", "Bina", "green"]);
  const [after] = await database().select().from(t.reportLinks).where(eq(t.reportLinks.id, forB.row.id));
  assert.deepEqual([after.openCount, !!after.firstOpenedAt], [1, true]);
  const notAvailable = async (who: string, token: string) => assert.equal((await refused(openReportLink({ id: who }, token)))?.code, "REPORT_LINK_UNAVAILABLE", who);
  await notAvailable("P2", forB.token); // Raj is Aadi's parent, not Bina's
  await notAvailable("P3", forB.token); // another family
  await notAvailable("owner", forB.token); // staff have no parent relationship (they use the staff screens)
  await notAvailable("blue-owner", forB.token);
  await notAvailable("P1", `${forB.token}x`);
  await notAvailable("P1", forB.token.replace(/^[^.]+/, "00000000-0000-4000-8000-000000000000"));
  await notAvailable("P1", "garbage");
  // the same parent opens Aadi's link too, and Raj (Aadi's other parent) can open THAT one: the relationship is per child
  const forA = await linkOf("rep-LA");
  assert.equal((await openReportLink({ id: "P2" }, forA.token)).childFirstName, "Aadi");
  // an unlinked parent, an expired link, a revoked link and a withdrawn report all stop opening
  await database().update(t.guardianLinks).set({ active: false }).where(and(eq(t.guardianLinks.userId, "P2"), eq(t.guardianLinks.playerId, "A")));
  await notAvailable("P2", forA.token);
  await database().update(t.guardianLinks).set({ active: true }).where(and(eq(t.guardianLinks.userId, "P2"), eq(t.guardianLinks.playerId, "A")));
  await database().update(t.reportLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(t.reportLinks.id, forA.row.id));
  await notAvailable("P1", forA.token);
  await database().update(t.reportLinks).set({ revokedAt: new Date() }).where(eq(t.reportLinks.id, forB.row.id));
  await notAvailable("P1", forB.token);
  await database().update(t.reportLinks).set({ revokedAt: null }).where(eq(t.reportLinks.id, forB.row.id));
  await database().update(t.reports).set({ status: "WITHDRAWN" }).where(eq(t.reports.id, "rep-L"));
  await notAvailable("P1", forB.token);
});

test("the official WhatsApp adapter: inert without every setting, template-only requests, honest outcomes, signed webhooks", async () => {
  assert.deepEqual((metaConfig({}) as { problems: string[] }).problems.length, 5, "nothing is configured by default");
  const env = { WHATSAPP_META_PHONE_NUMBER_ID: "123456789", WHATSAPP_META_ACCESS_TOKEN: "test-token", WHATSAPP_META_APP_SECRET: "app-secret", WHATSAPP_META_VERIFY_TOKEN: "verify", WHATSAPP_META_TEMPLATE: "report_ready" };
  const cfg = metaConfig(env);
  assert.ok(cfg.ok);
  if (!cfg.ok) return;
  assert.equal((metaConfig({ ...env, WHATSAPP_META_PHONE_NUMBER_ID: "abc" }) as { ok: boolean }).ok, false);
  assert.equal((metaConfig({ ...env, WHATSAPP_META_GRAPH_VERSION: "latest" }) as { ok: boolean }).ok, false);
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  const msg = { to: "+919876543210", templateName: "report_ready", language: "en", params: ["Priya", "Aadi", "https://x/l#1"], text: "t", idempotencyKey: "k" };
  const ok = await new MetaWhatsAppProvider(cfg.config, reply(200, { messages: [{ id: "wamid.1" }] })).send(msg);
  assert.deepEqual(ok, { ok: true, providerMessageId: "wamid.1" });
  const sent = JSON.parse(String(calls[0].init.body));
  assert.equal(calls[0].url, "https://graph.facebook.com/v21.0/123456789/messages");
  assert.deepEqual([sent.type, sent.to, sent.template.name, sent.template.language.code], ["template", "919876543210", "report_ready", "en"]);
  assert.deepEqual(sent.template.components[0].parameters.map((p: { text: string }) => p.text), msg.params);
  assert.ok(!("text" in sent), "never free text: only an approved template");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer test-token");
  assert.deepEqual(await new MetaWhatsAppProvider(cfg.config, reply(429, { error: { code: 4 } }, { "retry-after": "120" })).send(msg), { ok: false, retryable: true, errorCode: "META_429_4", retryAfterSeconds: 120 });
  assert.deepEqual(await new MetaWhatsAppProvider(cfg.config, reply(503, {})).send(msg), { ok: false, retryable: true, errorCode: "META_503_UNKNOWN" });
  assert.deepEqual(await new MetaWhatsAppProvider(cfg.config, reply(400, { error: { code: 132000 } })).send(msg), { ok: false, retryable: false, errorCode: "META_400_132000" });
  assert.deepEqual(await new MetaWhatsAppProvider(cfg.config, (async () => { throw new Error("offline"); }) as typeof fetch).send(msg), { ok: false, retryable: true, errorCode: "META_NETWORK" });
  assert.equal((await new MetaWhatsAppProvider(cfg.config, reply(200, {})).send(msg)).ok, false, "an acceptance with no message id is not trusted");
  // webhook signature and parsing
  const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.1", status: "delivered", timestamp: "1800000000" }, { id: "wamid.1", status: "read", timestamp: "1800000100" }, { id: "wamid.2", status: "failed", timestamp: "1800000200", errors: [{ code: 131026 }] }, { id: "wamid.3", status: "deleted" }], messages: [{ id: "in.1", from: "919876543210", timestamp: "1800000300", type: "text", text: { body: " stop " } }, { id: "in.2", from: "919876543210", type: "text", text: { body: "thanks" } }] } }] }] });
  const signature = `sha256=${createHmac("sha256", "app-secret").update(body).digest("hex")}`;
  assert.equal(verifyMetaSignature(body, signature, "app-secret"), true);
  assert.equal(verifyMetaSignature(`${body} `, signature, "app-secret"), false, "a changed body");
  assert.equal(verifyMetaSignature(body, signature, "other-secret"), false);
  assert.equal(verifyMetaSignature(body, null, "app-secret"), false);
  assert.equal(verifyMetaSignature(body, "sha256=zz", "app-secret"), false);
  const events = parseMetaWebhook(JSON.parse(body));
  assert.deepEqual(events.map((e) => (e.kind === "status" ? `${e.type}:${e.providerMessageId}` : `stop:${e.address}`)), ["DELIVERED:wamid.1", "READ:wamid.1", "FAILED:wamid.2", "stop:+919876543210"], "unknown statuses and ordinary replies are ignored");
  assert.equal(events[0].kind === "status" && events[0].occurredAt.toISOString(), "2027-01-15T08:00:00.000Z");
  assert.deepEqual(parseMetaWebhook({}), []);
  assert.deepEqual(parseMetaWebhook(null), []);
});

test("channels are off unless configured; the test adapter and the dev queue runner refuse production and live channels", async () => {
  assert.deepEqual(channelStates({}).EMAIL, { mode: "NONE", provider: "none", problems: [] });
  assert.equal(channelStates({ DISPATCH_EMAIL_PROVIDER: "test" }).EMAIL.mode, "TEST");
  assert.match(channelStates({ DISPATCH_EMAIL_PROVIDER: "ses" }).EMAIL.problems[0], /not available in this build/);
  assert.match(channelStates({ DISPATCH_EMAIL_PROVIDER: "postmark" }).EMAIL.problems[0], /not available in this build/);
  assert.equal(channelStates({ DISPATCH_EMAIL_PROVIDER: "test", NODE_ENV: "production" }).EMAIL.mode, "NONE", "no test adapter in production");
  assert.equal(channelStates({ DISPATCH_WHATSAPP_PROVIDER: "meta" }).WHATSAPP.mode, "NONE", "meta without its settings is inert");
  assert.ok(channelStates({ DISPATCH_WHATSAPP_PROVIDER: "meta" }).WHATSAPP.problems.length >= 5);
  assert.equal(channelStates({ DISPATCH_WHATSAPP_PROVIDER: "meta", WHATSAPP_META_PHONE_NUMBER_ID: "1234567", WHATSAPP_META_ACCESS_TOKEN: "x", WHATSAPP_META_APP_SECRET: "x", WHATSAPP_META_VERIFY_TOKEN: "x", WHATSAPP_META_TEMPLATE: "x" }).WHATSAPP.mode, "LIVE");
  assert.deepEqual(Object.keys(providersFromEnv({})), [], "no provider without configuration");
  const was = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    assert.throws(() => new TestEmailProvider(), /not available in production/);
    assert.equal((await refused(runQueueNowForTest(owner)))?.status, 403);
  } finally {
    (process.env as Record<string, string>).NODE_ENV = was ?? "test";
  }
  assert.equal((await refused(runQueueNowForTest(owner)))?.code, "NOT_TEST_MODE", "refused unless a channel is in test mode");
  assert.ok(await refused(runQueueNowForTest(coach)), "owner-level only");
  void config;
});
