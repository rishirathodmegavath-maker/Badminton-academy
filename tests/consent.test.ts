import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { foldHistory, isGranted } from "../src/modules/consent/domain";
import {
  CANARY,
  FIXTURE_PASSWORD,
  ROLES,
  ROLE_USER,
  SUBJECT_IDS,
  USERS,
  addFixtureUser,
  type Role,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { nextTestAddress, type TestClient } from "./helpers/client";
import { code, signedIn as signIn } from "./helpers/accounts";
/**
 * Phase 5: consent management. Versioned documents, an append-only decision history, the derived
 * current state, and who may read or change what. Everything runs over HTTP with real sessions and
 * checks the database afterwards, so a passing test means the stored history is right, not only the
 * response.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("consent");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const API = "/api/academy";
const post = (c: TestClient, route: string, body: unknown) => c.post(`${API}/${route}`, body);
const get = (c: TestClient, route: string) => c.get(`${API}/${route}`);
const signedIn = (email: string) => signIn(app, email, FIXTURE_PASSWORD);
let counter = 0;
const uid = () => `${Date.now().toString(36)}${++counter}`;
type Cat = "PORTAL" | "EMAIL" | "WHATSAPP";
type EventJson = {
  id: string;
  subjectUserId: string;
  category: Cat;
  decision: string;
  sequence: number;
  version: number | null;
  method: string;
  actorRole: string | null;
  actorName: string | null;
  authority: string | null;
  evidenceRef: string | null;
  reason: string | null;
  legacy: boolean;
};
type View = {
  player: { id: string; name: string };
  adultManagesOwnConsent: boolean;
  canRecordOnBehalf: boolean;
  policies: { id: string; category: Cat; version: number; title: string; body: string }[];
  subjects: {
    userId: string;
    name: string;
    relationship: string;
    active: boolean;
    categories: { category: Cat; granted: boolean; status: string; sequence: number; version: number | null; recordedBy: string | null }[];
  }[];
  events: EventJson[];
  nextCursor: string | null;
};
const view = async (c: TestClient, playerId: string, query = "") => {
  const r = await get(c, `consent/${playerId}${query}`);
  assert.equal(r.status, 200, r.text);
  return r.json as View;
};
const state = (v: View, userId: string, category: Cat) =>
  v.subjects.find((s) => s.userId === userId)!.categories.find((c) => c.category === category)!;
/** A clean player (and optionally its guardian link) in the green academy, with nothing granted. */
async function makePlayer(opts: { adultUserId?: string; guardian?: { id: string; relationship?: string; active?: boolean } } = {}) {
  const id = `cp-${uid()}`;
  await database().insert(t.players).values({ id, academyId: "green", batchId: "green-main", name: `Consent Player ${id}` });
  await database().insert(t.profiles).values({
    academyId: "green",
    playerId: id,
    data: { adult: !!opts.adultUserId, birthDate: "", email: "", phone: "", notes: "", status: "ACTIVE", selfUserId: opts.adultUserId ?? null, preferences: "" },
  });
  if (opts.guardian)
    await database().insert(t.guardianLinks).values({
      academyId: "green",
      playerId: id,
      userId: opts.guardian.id,
      relationship: opts.guardian.relationship ?? "Mother",
      active: opts.guardian.active ?? true,
      consent: { portal: false, email: false, whatsapp: false },
    });
  return id;
}
async function makeGuardian(role: Role = "GUARDIAN", academy: "green" | "blue" = "green") {
  const id = `cg-${uid()}`;
  const { email } = await addFixtureUser(id, [{ academyId: academy, role }]);
  return { id, email };
}
const dbEvents = (playerId: string, subject?: string) =>
  database()
    .select()
    .from(t.consentEvents)
    .where(and(eq(t.consentEvents.playerId, playerId), subject ? eq(t.consentEvents.subjectUserId, subject) : undefined))
    .orderBy(asc(t.consentEvents.recordedAt), asc(t.consentEvents.sequence));
const linkOf = async (playerId: string, userId: string) =>
  (await database().select().from(t.guardianLinks).where(and(eq(t.guardianLinks.playerId, playerId), eq(t.guardianLinks.userId, userId))))[0];
const secEvents = async (event: string) =>
  (await database().select().from(t.securityEvent).where(eq(t.securityEvent.event, event)));
const owner = () => app.as("owner");
/** The version of a category in force now (null while none is published): what a person would be shown. */
const curr = async (category: Cat) =>
  (
    await database()
      .select()
      .from(t.consentPolicyVersions)
      .where(and(eq(t.consentPolicyVersions.academyId, "green"), eq(t.consentPolicyVersions.category, category), eq(t.consentPolicyVersions.status, "PUBLISHED")))
      .orderBy(desc(t.consentPolicyVersions.version))
      .limit(1)
  )[0]?.id ?? null;
const grant = async (category: Cat) => ({ category, action: "GRANT" as const, versionId: await curr(category) });
const versionsMap = async () => ({ portal: await curr("PORTAL"), email: await curr("EMAIL"), whatsapp: await curr("WHATSAPP") });
async function publish(c: TestClient, category: Cat, requireRenewal = false, body = "I agree to receive these updates and understand I can withdraw at any time.") {
  const draft = await post(c, "consent/version", { category, title: `${category} consent`, body });
  let id: string;
  if (draft.status === 409 && code(draft) === "DRAFT_EXISTS") {
    // An earlier test left an open draft for this category: publish that one.
    const open = ((await get(c, "consent/policies")).json as { drafts: { id: string; category: string }[] }).drafts.find((d) => d.category === category)!;
    id = open.id;
  } else {
    assert.equal(draft.status, 200, draft.text);
    id = (draft.json as { id: string }).id;
  }
  const pub = await post(c, "consent/publish", { id, requireRenewal });
  assert.equal(pub.status, 200, pub.text);
  return { id, ...(pub.json as { version: number; lapsed: number }) };
}
/** The history must always explain the flag: the invariant the whole design rests on. */
async function assertConsistent(playerId: string, userId: string) {
  const link = await linkOf(playerId, userId);
  const all = await dbEvents(playerId, userId);
  for (const [category, key] of [["PORTAL", "portal"], ["EMAIL", "email"], ["WHATSAPP", "whatsapp"]] as const) {
    const events = all.filter((e) => e.category === category);
    assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1), `${category}: contiguous sequences`);
    events.forEach((e, i) => {
      assert.equal(e.previousEventId, i ? events[i - 1].id : null, `${category}: chain`);
      assert.equal(e.previousDecision, i ? events[i - 1].decision : null);
    });
    assert.equal(link.consent[key], foldHistory(events), `${category}: flag equals the folded history`);
  }
}
const decide = (c: TestClient, playerId: string, decisions: unknown[], extra: Record<string, unknown> = {}) =>
  post(c, "consent/decide", { playerId, decisions, ...extra });
// ============================================================================================
test("legacy flags without history: shown honestly, withdrawable, never converted into invented history", async () => {
  // childA's guardian was seeded with portal and email on and no history (as pre-Phase-5 data would be before migration).
  const guardian = await app.as("guardian");
  const before = await view(guardian, SUBJECT_IDS.childA);
  const portal = state(before, USERS.guardian.id, "PORTAL");
  assert.deepEqual([portal.granted, portal.status, portal.sequence], [true, "UNRECORDED", 0]);
  assert.deepEqual(before.events, []);
  const out = await decide(guardian, SUBJECT_IDS.childA, [{ category: "EMAIL", action: "WITHDRAW" }]);
  assert.deepEqual((out.json as { changes: unknown[] }).changes, [{ category: "EMAIL", decision: "WITHDRAWN" }]);
  const [event] = await dbEvents(SUBJECT_IDS.childA, USERS.guardian.id);
  assert.deepEqual([event.decision, event.previousDecision, event.previousEventId, event.sequence], ["WITHDRAWN", null, null, 1]);
  assert.equal((await linkOf(SUBJECT_IDS.childA, USERS.guardian.id)).consent.email, false);
  assert.equal(isGranted("LAPSED"), false);
});
test("initial consent, duplicates, withdrawal and the append-only history (no versions published yet)", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id, relationship: "Aunt" } });
  const client = await signedIn(g.email);
  let v = await view(client, player);
  assert.deepEqual(v.subjects[0].categories.map((c) => c.status), ["NONE", "NONE", "NONE"]);
  assert.deepEqual(v.events, []);
  const granted = await decide(client, player, [await grant("PORTAL"), await grant("EMAIL")]);
  assert.equal(granted.status, 200, granted.text);
  assert.deepEqual((granted.json as { changes: unknown[] }).changes, [
    { category: "PORTAL", decision: "GRANTED" },
    { category: "EMAIL", decision: "GRANTED" },
  ]);
  const [first] = await dbEvents(player, g.id);
  assert.deepEqual(
    [first.decision, first.method, first.actorId, first.actorRole, first.authority, first.policyVersionId, first.sequence, first.previousEventId],
    ["GRANTED", "PORTAL_SELF", g.id, "GUARDIAN", "Aunt", null, 1, null],
  );
  assert.ok(first.recordedAt instanceof Date && first.effectiveAt instanceof Date);
  assert.deepEqual((await linkOf(player, g.id)).consent, { portal: true, email: true, whatsapp: false });
  // The same request again is a duplicate submission: no event, no change.
  const again = await decide(client, player, [await grant("PORTAL")]);
  assert.deepEqual((again.json as { changes: unknown[] }).changes, []);
  assert.equal((await dbEvents(player, g.id)).length, 2);
  // Withdrawal appends; the acceptance is still there, unchanged.
  const before = JSON.stringify(await dbEvents(player, g.id));
  const out = await decide(client, player, [{ category: "EMAIL", action: "WITHDRAW", reason: "Too many messages." }]);
  assert.equal(out.status, 200, out.text);
  const after = await dbEvents(player, g.id);
  assert.equal(after.length, 3);
  assert.equal(JSON.stringify(after.slice(0, 2)), before, "earlier events are untouched");
  const w = after[2];
  assert.deepEqual([w.decision, w.sequence, w.previousDecision, w.reason], ["WITHDRAWN", 2, "GRANTED", "Too many messages."]);
  assert.equal((await linkOf(player, g.id)).consent.email, false);
  // Withdrawing what is not granted does nothing.
  assert.deepEqual(((await decide(client, player, [{ category: "WHATSAPP", action: "WITHDRAW" }])).json as { changes: unknown[] }).changes, []);
  v = await view(client, player);
  assert.deepEqual(v.subjects[0].categories.map((c) => [c.category, c.status, c.granted]), [["PORTAL", "CURRENT", true], ["EMAIL", "WITHDRAWN", false], ["WHATSAPP", "NONE", false]]);
  assert.deepEqual(v.events.map((e) => `${e.category}:${e.decision}`).sort(), ["EMAIL:GRANTED", "EMAIL:WITHDRAWN", "PORTAL:GRANTED"]);
  assert.equal(v.events.length, 3);
  await assertConsistent(player, g.id);
});
test("versioned documents: exact version recorded, newer versions imply nothing, renewal and lapse are explicit events", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const boss = await owner();
  const client = await signedIn(g.email);
  const v1 = await publish(boss, "EMAIL");
  assert.equal(v1.version, 1);
  // Accepting needs the version that was presented.
  const none = await decide(client, player, [{ category: "EMAIL", action: "GRANT" }]);
  assert.equal(none.status, 422);
  assert.equal(code(none), "VERSION_REQUIRED");
  const wrong = await decide(client, player, [{ category: "EMAIL", action: "GRANT", versionId: crypto.randomUUID() }]);
  assert.equal(wrong.status, 409);
  assert.equal(code(wrong), "STALE_VERSION");
  assert.equal((await dbEvents(player, g.id)).length, 0);
  assert.equal((await decide(client, player, [{ category: "EMAIL", action: "GRANT", versionId: v1.id }])).status, 200);
  assert.equal((await dbEvents(player, g.id))[0].policyVersionId, v1.id);
  let s = state(await view(client, player), g.id, "EMAIL");
  assert.deepEqual([s.status, s.version, s.granted], ["CURRENT", 1, true]);
  // Version 2 (consent carries over): nothing is accepted automatically; renewal is requested.
  const v2 = await publish(boss, "EMAIL", false);
  assert.equal(v2.version, 2);
  assert.equal(v2.lapsed, 0);
  s = state(await view(client, player), g.id, "EMAIL");
  assert.deepEqual([s.status, s.version, s.granted], ["RENEWAL_REQUESTED", 1, true]);
  assert.equal((await dbEvents(player, g.id)).length, 1, "publishing wrote no decision for anyone");
  assert.equal((await linkOf(player, g.id)).consent.email, true, "existing consent stays in force until renewed or withdrawn");
  const stale = await decide(client, player, [{ category: "EMAIL", action: "GRANT", versionId: v1.id }]);
  assert.equal(code(stale), "STALE_VERSION", "the superseded text cannot be accepted any more");
  const renewed = await decide(client, player, [{ category: "EMAIL", action: "GRANT", versionId: v2.id }]);
  assert.deepEqual((renewed.json as { changes: unknown[] }).changes, [{ category: "EMAIL", decision: "RENEWED" }]);
  assert.deepEqual((await dbEvents(player, g.id)).map((e) => [e.decision, e.policyVersionId]), [["GRANTED", v1.id], ["RENEWED", v2.id]], "history keeps pointing at the original version");
  // Version 3 requires renewal: consent LAPSES through an explicit, attributed event.
  const v3 = await publish(boss, "EMAIL", true);
  assert.equal(v3.lapsed >= 1, true);
  const lapsed = (await dbEvents(player, g.id)).at(-1)!;
  assert.deepEqual([lapsed.decision, lapsed.method, lapsed.actorId, lapsed.actorRole, lapsed.policyVersionId], ["LAPSED", "SYSTEM_POLICY", USERS.owner.id, "OWNER", v3.id]);
  assert.equal((await linkOf(player, g.id)).consent.email, false);
  s = state(await view(client, player), g.id, "EMAIL");
  assert.deepEqual([s.status, s.granted], ["LAPSED", false]);
  assert.equal((await decide(client, player, [{ category: "EMAIL", action: "GRANT", versionId: v3.id }])).status, 200);
  assert.equal((await dbEvents(player, g.id)).at(-1)!.decision, "GRANTED");
  await assertConsistent(player, g.id);
  // Other categories are unaffected by an EMAIL version, and have no version yet.
  assert.equal((await decide(client, player, [await grant("PORTAL")])).status, 200);
  assert.equal((await decide(client, player, [{ category: "WHATSAPP", action: "GRANT", versionId: v3.id }])).status, 422, "a version of another category is not a version of this one");
});
test("published documents are frozen: API and database both refuse changes; drafts are managed safely", async () => {
  const boss = await owner();
  const draft = await post(boss, "consent/version", { category: "WHATSAPP", title: "WhatsApp consent", body: "First draft text of the WhatsApp consent." });
  assert.equal(draft.status, 200, draft.text);
  const { id } = draft.json as { id: string; version: number };
  const dup = await post(boss, "consent/version", { category: "WHATSAPP", title: "Another", body: "A second draft for the same category." });
  assert.equal(code(dup), "DRAFT_EXISTS");
  const edited = await post(boss, "consent/version", { id, category: "WHATSAPP", title: "WhatsApp consent", body: "Edited draft text of the WhatsApp consent." });
  assert.equal(edited.status, 200, edited.text);
  assert.equal((await post(boss, "consent/version", { id, category: "EMAIL", title: "WhatsApp consent", body: "Edited draft text of the WhatsApp consent." })).status >= 400, true, "category cannot change");
  assert.equal((await post(boss, "consent/publish", { id, requireRenewal: false })).status, 200);
  assert.equal(code(await post(boss, "consent/publish", { id, requireRenewal: false })), "VERSION_PUBLISHED");
  assert.equal(code(await post(boss, "consent/version", { id, category: "WHATSAPP", title: "Changed", body: "Silently changed published text here." })), "VERSION_PUBLISHED");
  const db = database();
  const frozen = (text: string) => (e: unknown) => /cannot be (changed|deleted)/.test(`${e} ${(e as { cause?: unknown }).cause}`) || text === "";
  await assert.rejects(() => db.update(t.consentPolicyVersions).set({ body: "tampered" }).where(eq(t.consentPolicyVersions.id, id)), frozen("update"));
  await assert.rejects(() => db.update(t.consentPolicyVersions).set({ status: "DRAFT", publishedAt: null, effectiveAt: null }).where(eq(t.consentPolicyVersions.id, id)), frozen("revert"));
  await assert.rejects(() => db.delete(t.consentPolicyVersions).where(eq(t.consentPolicyVersions.id, id)), frozen("delete"));
  const [row] = await db.select().from(t.consentPolicyVersions).where(eq(t.consentPolicyVersions.id, id));
  assert.equal(row.body, "Edited draft text of the WhatsApp consent.");
  // The next version is a new row with the next number.
  const next = await post(boss, "consent/version", { category: "WHATSAPP", title: "WhatsApp consent v2", body: "Second version of the WhatsApp consent." });
  assert.equal((next.json as { version: number }).version, 2);
  // Another academy can neither see nor publish it.
  const blue = await app.as("blueOwner");
  assert.equal((await post(blue, "consent/publish", { id: (next.json as { id: string }).id, requireRenewal: false })).status, 404);
  const blueList = (await get(blue, "consent/policies")).json as { versions: unknown[]; drafts: unknown[]; current: unknown[] };
  assert.deepEqual([blueList.versions, blueList.drafts, blueList.current], [[], [], []]);
  assert.equal((await post(boss, "consent/version", { category: "SMS", title: "x", body: "y".repeat(30) })).status, 422);
});
test("the history table is append-only and its integrity rules hold in the database itself", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  await decide(await signedIn(g.email), player, [await grant("PORTAL")]);
  const db = database();
  const [event] = await dbEvents(player, g.id);
  const cause = (e: unknown) => `${e} ${(e as { cause?: unknown }).cause}`;
  await assert.rejects(() => db.update(t.consentEvents).set({ decision: "WITHDRAWN" }).where(eq(t.consentEvents.id, event.id)), (e) => /append-only/.test(cause(e)));
  await assert.rejects(() => db.delete(t.consentEvents).where(eq(t.consentEvents.id, event.id)), (e) => /append-only/.test(cause(e)));
  assert.equal((await dbEvents(player, g.id)).length, 1);
  const base = { id: crypto.randomUUID(), academyId: "green", playerId: player, subjectUserId: g.id, category: "PORTAL", sequence: 2, decision: "GRANTED", method: "PORTAL_SELF" };
  const rejects = (values: Record<string, unknown>, pattern: RegExp) =>
    assert.rejects(() => db.insert(t.consentEvents).values({ ...base, id: crypto.randomUUID(), ...values } as never), (e) => pattern.test(cause(e)));
  await rejects({ sequence: 1 }, /consent_event_sequence|unique|duplicate/i);
  await rejects({ category: "SMS" }, /category_check/);
  await rejects({ decision: "MAYBE" }, /decision_check/);
  await rejects({ method: "TELEPATHY" }, /method_check/);
  await rejects({ sequence: 0 }, /sequence_check/);
  await rejects({ method: "STAFF_WRITTEN" }, /evidence_check/);
  await rejects({ method: "STAFF_WRITTEN", evidenceRef: "   " }, /evidence_check/);
  await rejects({ method: "IMPORT_LEGACY", actorId: g.id }, /legacy_check/);
  await rejects({ method: "SYSTEM_POLICY" }, /system_check/);
  await rejects({ decision: "LAPSED" }, /system_check/);
  await rejects({ subjectUserId: "not-a-linked-person" }, /foreign key|violates/i);
  await rejects({ playerId: SUBJECT_IDS.blue }, /foreign key|violates/i);
  await rejects({ policyVersionId: "no-such-version" }, /foreign key|violates/i);
  assert.equal((await dbEvents(player, g.id)).length, 1);
  await db.insert(t.consentEvents).values({ ...base, evidenceRef: undefined, sequence: 2 } as never);
  assert.equal((await dbEvents(player, g.id)).length, 2, "INSERT is the one thing allowed");
});
test("guardians: strictly their own children and their own consent", async () => {
  const mine = await makeGuardian();
  const other = await makeGuardian();
  const player = await makePlayer({ guardian: { id: mine.id } });
  const otherPlayer = await makePlayer({ guardian: { id: other.id } });
  const client = await signedIn(mine.email);
  assert.equal((await get(client, `consent/${player}`)).status, 200);
  // Direct-ID attempts at another family's child.
  assert.equal((await get(client, `consent/${otherPlayer}`)).status, 404);
  assert.equal((await decide(client, otherPlayer, [await grant("PORTAL")])).status, 404);
  assert.equal((await get(client, `consent/${SUBJECT_IDS.blue}`)).status, 404, "another academy's child");
  assert.equal((await get(client, "consent/no-such-player")).status, 404);
  // A forged subject, or staff-only fields, are refused; nothing is written.
  assert.equal((await decide(client, player, [await grant("PORTAL")], { subjectUserId: other.id })).status, 403);
  assert.equal((await decide(client, otherPlayer, [await grant("PORTAL")], { subjectUserId: other.id })).status, 404);
  assert.equal((await decide(client, player, [await grant("PORTAL")], { method: "STAFF_WRITTEN", evidenceRef: "x" })).status, 422);
  assert.equal((await decide(client, player, [await grant("PORTAL")], { effectiveAt: "2001-01-01T00:00:00Z" })).status, 422);
  assert.equal((await dbEvents(player)).length + (await dbEvents(otherPlayer)).length, 0);
  // A second guardian of the same child manages only their own consent.
  const second = await makeGuardian();
  await database().insert(t.guardianLinks).values({ academyId: "green", playerId: player, userId: second.id, relationship: "Father", consent: { portal: false, email: false, whatsapp: false } });
  const c2 = await signedIn(second.email);
  await decide(c2, player, [await grant("PORTAL")]);
  const v1 = await view(client, player);
  assert.deepEqual(v1.subjects.map((s) => s.userId), [mine.id], "no sight of the co-guardian's decisions");
  assert.deepEqual(v1.events, []);
  assert.ok(!JSON.stringify(v1).includes(second.id));
  assert.equal((await linkOf(player, mine.id)).consent.portal, false);
  assert.equal((await linkOf(player, second.id)).consent.portal, true);
  // A revoked link ends access at once; the history is retained and reachable by administrators.
  await decide(client, player, [await grant("EMAIL")]);
  await post(await owner(), "players/guardian", { playerId: player, userId: mine.id, relationship: "Mother", active: false });
  assert.equal((await get(client, `consent/${player}`)).status, 404);
  assert.equal((await decide(client, player, [{ category: "EMAIL", action: "WITHDRAW" }])).status, 404);
  const admin = await view(await owner(), player);
  assert.equal(admin.subjects.find((s) => s.userId === mine.id)!.active, false);
  assert.ok(admin.events.some((e) => e.subjectUserId === mine.id), "history is kept");
  // Nor can staff record anything for a person whose link has been revoked.
  const onBehalf = await decide(await owner(), player, [{ category: "EMAIL", action: "WITHDRAW" }], { subjectUserId: mine.id, method: "STAFF_VERBAL" });
  assert.equal(onBehalf.status, 404);
  assert.equal((await dbEvents(player, mine.id)).length, 1, "nothing was recorded for the revoked link");
  await post(await owner(), "players/guardian", { playerId: player, userId: mine.id, relationship: "Mother", active: true });
  assert.equal((await get(client, `consent/${player}`)).status, 200);
  await assertConsistent(player, mine.id);
});
test("a deactivated guardian account has no access at all", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  assert.equal((await get(client, `consent/${player}`)).status, 200);
  await database().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, g.id));
  const r = await get(client, `consent/${player}`);
  assert.ok(r.status === 403 || r.status === 401, `status ${r.status}`);
  assert.equal((await decide(client, player, [await grant("PORTAL")])).status === 200, false);
  assert.equal((await dbEvents(player)).length, 0);
});
test("adult players decide for themselves; guardians cannot stand in", async () => {
  const adult = await makeGuardian("ADULT_PLAYER");
  const player = await makePlayer({ adultUserId: adult.id });
  const guardian = await makeGuardian();
  await database().insert(t.guardianLinks).values({ academyId: "green", playerId: player, userId: guardian.id, relationship: "Parent", consent: { portal: true, email: false, whatsapp: false } });
  const self = await signedIn(adult.email);
  let v = await view(self, player);
  assert.equal(v.adultManagesOwnConsent, true);
  assert.deepEqual(v.subjects.map((s) => [s.userId, s.relationship]), [[adult.id, "Adult self"]]);
  assert.deepEqual(v.subjects[0].categories.map((c) => c.status), ["NONE", "NONE", "NONE"]);
  assert.equal((await decide(self, player, [await grant("PORTAL"), await grant("EMAIL")])).status, 200);
  const link = await linkOf(player, adult.id);
  assert.deepEqual([link.relationship, link.consent], ["Adult self", { portal: true, email: true, whatsapp: false }]);
  assert.equal((await decide(self, player, [{ category: "EMAIL", action: "WITHDRAW" }])).status, 200);
  v = await view(self, player);
  assert.deepEqual(v.events.map((e) => `${e.category}:${e.decision}:${e.method}:${e.actorRole}`).sort(), ["EMAIL:GRANTED:PORTAL_SELF:ADULT_PLAYER", "EMAIL:WITHDRAWN:PORTAL_SELF:ADULT_PLAYER", "PORTAL:GRANTED:PORTAL_SELF:ADULT_PLAYER"]);
  await assertConsistent(player, adult.id);
  // Not anyone else's: another player, a child, another academy.
  assert.equal((await get(self, `consent/${SUBJECT_IDS.childA}`)).status, 404);
  assert.equal((await decide(self, SUBJECT_IDS.childA, [{ category: "PORTAL", action: "WITHDRAW" }])).status, 404);
  assert.equal((await get(self, `consent/${SUBJECT_IDS.blue}`)).status, 404);
  assert.equal((await decide(self, player, [{ category: "PORTAL", action: "WITHDRAW" }], { subjectUserId: guardian.id })).status, 403);
  // A guardian linked to an adult cannot read or decide; the guardian's own recorded flags are not theirs to change here.
  const gc = await signedIn(guardian.email);
  assert.equal((await get(gc, `consent/${player}`)).status, 404);
  assert.equal((await decide(gc, player, [{ category: "PORTAL", action: "WITHDRAW" }])).status, 404);
  assert.equal((await linkOf(player, guardian.id)).consent.portal, true);
  // Staff may record only the adult's own consent (written evidence), not a guardian's.
  const boss = await owner();
  assert.equal((await decide(boss, player, [await grant("WHATSAPP")], { subjectUserId: guardian.id, method: "STAFF_WRITTEN", evidenceRef: "Form 9" })).status, 403);
  assert.equal((await decide(boss, player, [await grant("WHATSAPP")], { subjectUserId: adult.id, method: "STAFF_WRITTEN", evidenceRef: "Form 9" })).status, 200);
  assert.equal((await linkOf(player, adult.id)).consent.whatsapp, true);
});
test("roles: coaches, head coaches, finance and nutrition professionals have no consent access; only owner/admin administer", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  await decide(await signedIn(g.email), player, [await grant("PORTAL")]);
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    const read = await get(client, `consent/${player}`);
    const policies = await get(client, "consent/policies");
    const report = await get(client, "consent/report");
    const write = await decide(client, player, [{ category: "PORTAL", action: "WITHDRAW" }], { subjectUserId: g.id, method: "STAFF_WRITTEN" });
    const admin = role === "OWNER" || role === "ADMIN";
    if (role === "GUARDIAN" || role === "ADULT_PLAYER") {
      assert.equal(policies.status, 200, role);
      assert.equal(report.status, 403, role);
      assert.equal(read.status, 404, `${role} is not linked to this child`);
      assert.ok(write.status >= 400, `${role} ${write.status}`);
    } else if (admin) {
      assert.equal(read.status, 200, role);
      assert.equal(report.status, 200, role);
      assert.equal(policies.status, 200, role);
    } else {
      for (const r of [read, policies, report, write]) {
        assert.equal(r.status, 403, `${role} ${r.text.slice(0, 80)}`);
        assert.deepEqual(r.json, { error: "Your role cannot perform this action." });
      }
    }
  }
  // Nothing was withdrawn by the refused calls (an owner/admin withdrawal above is allowed and recorded).
  const events = await dbEvents(player, g.id);
  assert.ok(events.every((e) => e.actorRole === "GUARDIAN" || e.actorRole === "OWNER" || e.actorRole === "ADMIN"));
  assert.equal((await app.anonymous().get(`${API}/consent/${player}`)).status, 401);
  assert.equal((await app.anonymous().post(`${API}/consent/decide`, { playerId: player, decisions: [] })).status, 401);
  // A coach does not even receive families' consent flags in the academy payload.
  const coach = (await get(await app.as("coach"), "")).json as { guardianLinks: unknown[] };
  assert.deepEqual(coach.guardianLinks, []);
  // Policy administration is owner/admin only.
  for (const key of ["coach", "headCoach", "finance", "nutrition", "guardian", "adult"] as const) {
    const c = await app.as(key);
    assert.equal((await post(c, "consent/version", { category: "PORTAL", title: "Nope nope", body: "Not allowed to write this text." })).status, 403, key);
    assert.equal((await post(c, "consent/publish", { id: "x", requireRenewal: false })).status, 403, key);
  }
});
test("owner/admin record decisions on someone's behalf: method and evidence required, attributed, and flagged until the person confirms", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id, relationship: "Grandmother" } });
  const unlinked = await makeGuardian();
  for (const key of ["owner", "admin"] as const) {
    const staff = await app.as(key);
    const noMethod = await decide(staff, player, [await grant("PORTAL")], { subjectUserId: g.id });
    assert.equal(code(noMethod), "METHOD_REQUIRED");
    const noEvidence = await decide(staff, player, [await grant("PORTAL")], { subjectUserId: g.id, method: "STAFF_VERBAL" });
    assert.equal(code(noEvidence), "EVIDENCE_REQUIRED");
    const noSubject = await decide(staff, player, [await grant("PORTAL")], { method: "STAFF_VERBAL", evidenceRef: "Call log 14" });
    assert.equal(noSubject.status, 422);
    assert.equal((await decide(staff, player, [await grant("PORTAL")], { subjectUserId: unlinked.id, method: "STAFF_VERBAL", evidenceRef: "Call 1" })).status, 404, "not linked to this child");
    assert.equal((await decide(staff, player, [await grant("PORTAL")], { subjectUserId: g.id, method: "AI_GUESS", evidenceRef: "x" })).status, 422);
  }
  assert.equal((await dbEvents(player, g.id)).length, 0);
  const boss = await owner();
  const stated = "2031-01-01T00:00:00.000Z";
  const ok = await decide(boss, player, [await grant("PORTAL")], { subjectUserId: g.id, method: "STAFF_WRITTEN", evidenceRef: "Form 12 (signed 3 May)", effectiveAt: stated });
  assert.equal(ok.status, 200, ok.text);
  let [e] = await dbEvents(player, g.id);
  assert.notEqual(e.effectiveAt!.toISOString(), stated, "a stated date in the future is not believed");
  const past = new Date(Date.now() - 5 * 86400000).toISOString();
  await decide(await app.as("admin"), player, [await grant("EMAIL")], { subjectUserId: g.id, method: "STAFF_VERBAL", evidenceRef: "Phone, 2 pm", effectiveAt: past });
  [, e] = await dbEvents(player, g.id);
  assert.deepEqual([e.actorRole, e.actorId, e.method, e.evidenceRef, e.effectiveAt!.toISOString(), e.authority], ["ADMIN", USERS.admin.id, "STAFF_VERBAL", "Phone, 2 pm", past, "Grandmother"]);
  assert.ok(e.recordedAt.getTime() > new Date(past).getTime(), "recorded_at is the server clock, effective_at what was stated");
  // Staff may withdraw on someone's behalf without evidence.
  assert.equal((await decide(boss, player, [{ category: "EMAIL", action: "WITHDRAW" }], { subjectUserId: g.id, method: "STAFF_VERBAL" })).status, 200);
  // The person sees that this was recorded for them (and by which capacity), not the staff member's name or evidence.
  const mine = await view(await signedIn((await database().select().from(t.user).where(eq(t.user.id, g.id)))[0].email), player);
  assert.equal(mine.subjects[0].categories.find((c) => c.category === "PORTAL")!.recordedBy, "STAFF_WRITTEN");
  assert.ok(mine.events.every((x) => x.actorName === null && x.evidenceRef === null && x.actorRole !== "GUARDIAN"));
  // The administrator's view carries who and why.
  const admin = await view(boss, player);
  assert.ok(admin.events.some((x) => x.actorName && x.evidenceRef === "Form 12 (signed 3 May)"));
  // The person's own confirmation is a new event under their own authority.
  await decide(await signedIn((await database().select().from(t.user).where(eq(t.user.id, g.id)))[0].email), player, [await grant("PORTAL")]);
  const last = (await dbEvents(player, g.id)).filter((x) => x.category === "PORTAL").at(-1)!;
  assert.deepEqual([last.method, last.decision, last.actorRole], ["PORTAL_SELF", "RENEWED", "GUARDIAN"]);
  await assertConsistent(player, g.id);
});
test("cross-academy: nothing leaks either way, including documents, history and the report", async () => {
  const boss = await owner();
  const blue = await app.as("blueOwner");
  const blueGuardian = await app.as("blueGuardian");
  assert.equal((await get(blue, `consent/${SUBJECT_IDS.childA}`)).status, 404);
  assert.equal((await get(boss, `consent/${SUBJECT_IDS.blue}`)).status, 404);
  assert.equal((await decide(blue, SUBJECT_IDS.childA, [await grant("PORTAL")], { subjectUserId: USERS.guardian.id, method: "STAFF_WRITTEN", evidenceRef: "x" })).status, 404);
  assert.equal((await get(blueGuardian, `consent/${SUBJECT_IDS.childA}`)).status, 404);
  assert.equal((await decide(blueGuardian, SUBJECT_IDS.childA, [{ category: "PORTAL", action: "WITHDRAW" }])).status, 404);
  await publish(boss, "PORTAL", false, "Green academy portal consent document text.");
  const blueDocs = (await get(blue, "consent/policies")).json as { current: unknown[] };
  assert.deepEqual(blueDocs.current, []);
  const blueGuardianDocs = (await get(blueGuardian, "consent/policies")).json as { current: unknown[] };
  assert.deepEqual(blueGuardianDocs.current, [], "a guardian sees only their own academy's documents");
  const report = JSON.stringify((await get(blue, "consent/report")).json);
  assert.ok(!report.includes(CANARY.childA.name) && !report.includes(USERS.guardian.id));
  // A forged academy in the body is ignored: the academy always comes from the session.
  assert.equal((await post(blue, "consent/decide", { academyId: "green", playerId: SUBJECT_IDS.childA, subjectUserId: USERS.guardian.id, decisions: [{ category: "PORTAL", action: "WITHDRAW" }], method: "STAFF_VERBAL" })).status, 404);
});
test("concurrent and conflicting decisions are serialised and never corrupt the history", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  const copies = Array.from({ length: 8 }, () => client.clone(nextTestAddress()));
  const portalGrant = await grant("PORTAL");
  const same = await Promise.all(copies.map((c) => decide(c, player, [portalGrant])));
  assert.ok(same.every((r) => r.status === 200), same.map((r) => r.text).join());
  assert.equal((await dbEvents(player, g.id)).length, 1, "eight identical submissions, one decision");
  const emailGrant = await grant("EMAIL");
  // Opposite decisions at once: both are applied, in some order, and the history stays coherent.
  const mixed = await Promise.all(
    copies.map((c, i) => decide(c, player, [i % 2 ? { category: "EMAIL", action: "WITHDRAW" } : emailGrant])),
  );
  assert.ok(mixed.every((r) => r.status === 200));
  await assertConsistent(player, g.id);
  // An optimistic precondition detects a change made since the person opened the page.
  const opened = state(await view(client, player), g.id, "PORTAL");
  assert.equal(opened.sequence, 1);
  await decide(await owner(), player, [{ category: "PORTAL", action: "WITHDRAW" }], { subjectUserId: g.id, method: "STAFF_VERBAL" });
  const conflict = await decide(client, player, [await grant("PORTAL")], { basedOn: { PORTAL: opened.sequence } });
  assert.equal(conflict.status, 409);
  assert.equal(code(conflict), "CONSENT_CONFLICT");
  assert.equal((await linkOf(player, g.id)).consent.portal, false, "the stale decision changed nothing");
  const fresh = state(await view(client, player), g.id, "PORTAL");
  assert.equal((await decide(client, player, [await grant("PORTAL")], { basedOn: { PORTAL: fresh.sequence } })).status, 200);
  await assertConsistent(player, g.id);
});
test("a failure after the event is written rolls back the event, the flags and the security log together", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  await decide(client, player, [await grant("PORTAL")]);
  const db = database();
  const eventsBefore = JSON.stringify(await dbEvents(player, g.id));
  const securityBefore = (await secEvents("CONSENT_WITHDRAWN")).length;
  await db.execute(sql.raw(`create function consent_test_fail() returns trigger as $$ begin raise exception 'injected failure'; end; $$ language plpgsql`));
  await db.execute(sql.raw(`create trigger consent_test_fail before insert on security_event for each row when (new.event = 'CONSENT_WITHDRAWN') execute function consent_test_fail()`));
  try {
    const failed = await decide(client, player, [{ category: "PORTAL", action: "WITHDRAW" }]);
    assert.equal(failed.status, 500);
    assert.equal(JSON.stringify(await dbEvents(player, g.id)), eventsBefore, "no event survives");
    assert.equal((await linkOf(player, g.id)).consent.portal, true, "the flag did not change");
    assert.equal((await secEvents("CONSENT_WITHDRAWN")).length, securityBefore);
  } finally {
    await db.execute(sql.raw(`drop trigger consent_test_fail on security_event`));
    await db.execute(sql.raw(`drop function consent_test_fail()`));
  }
  assert.equal((await decide(client, player, [{ category: "PORTAL", action: "WITHDRAW" }])).status, 200, "the same request works once the fault is gone");
  await assertConsistent(player, g.id);
});
test("property: 120 random operations across versions keep flags, sequences and chains consistent", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  const boss = await owner();
  let seed = 20260505;
  const rand = (n: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const cats: Cat[] = ["PORTAL", "EMAIL", "WHATSAPP"];
  for (let i = 0; i < 120; i++) {
    const category = cats[rand(3)];
    const roll = rand(10);
    if (roll === 0) {
      await publish(boss, category, rand(2) === 0);
    } else if (roll < 6) {
      const current = ((await view(client, player)).policies.find((p) => p.category === category))?.id;
      const r = await decide(client, player, [{ category, action: "GRANT", versionId: current ?? null }]);
      assert.equal(r.status, 200, r.text);
    } else {
      assert.equal((await decide(client, player, [{ category, action: "WITHDRAW" }])).status, 200);
    }
    if (i % 10 === 9) await assertConsistent(player, g.id);
  }
  await assertConsistent(player, g.id);
});
test("the existing link and self-service endpoints keep working and now write the history", async () => {
  const g = await makeGuardian();
  const player = await makePlayer();
  const head = await app.as("headCoach");
  const boss = await owner();
  // A head coach may still manage the link, but a new link starts with nothing granted and they cannot change consent.
  const linked = await post(head, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true });
  assert.equal(linked.status, 200, linked.text);
  assert.deepEqual((await linkOf(player, g.id)).consent, { portal: false, email: false, whatsapp: false });
  assert.deepEqual(await dbEvents(player), []);
  const hc = await post(head, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true, consent: { portal: true, email: false, whatsapp: false }, consentMethod: "STAFF_WRITTEN", evidenceRef: "Form 1" });
  assert.equal(hc.status, 403);
  // Unchanged consent in the request is not a change.
  assert.equal((await post(head, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true, consent: { portal: false, email: false, whatsapp: false } })).status, 200);
  // Owner: method and evidence required for a change.
  const missing = await post(boss, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true, consent: { portal: true, email: false, whatsapp: false } });
  assert.equal(code(missing), "METHOD_REQUIRED");
  const noEvidence = await post(boss, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true, consent: { portal: true, email: false, whatsapp: false }, consentMethod: "STAFF_WRITTEN" });
  assert.equal(code(noEvidence), "EVIDENCE_REQUIRED");
  assert.deepEqual(await dbEvents(player), [], "a refused change leaves neither link changes in consent nor events");
  const ok = await post(boss, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true, consent: { portal: true, email: true, whatsapp: false }, consentMethod: "STAFF_WRITTEN", evidenceRef: "Form 1", consentVersions: await versionsMap() });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual((await dbEvents(player, g.id)).map((e) => [e.category, e.decision, e.method, e.actorRole]), [["PORTAL", "GRANTED", "STAFF_WRITTEN", "OWNER"], ["EMAIL", "GRANTED", "STAFF_WRITTEN", "OWNER"]]);
  // Omitting consent leaves it as it is.
  await post(boss, "players/guardian", { playerId: player, userId: g.id, relationship: "Aunt", active: true });
  assert.deepEqual((await linkOf(player, g.id)).consent, { portal: true, email: true, whatsapp: false });
  // The long-standing family endpoint records one event per CHANGED channel only.
  const client = await signedIn(g.email);
  const one = await post(client, "players/consent", { playerId: player, consent: { portal: true, email: false, whatsapp: true }, versions: await versionsMap() });
  assert.equal(one.status, 200, one.text);
  assert.deepEqual((await dbEvents(player, g.id)).slice(2).map((e) => `${e.category}:${e.decision}:${e.method}`).sort(), ["EMAIL:WITHDRAWN:PORTAL_SELF", "PORTAL:RENEWED:PORTAL_SELF", "WHATSAPP:GRANTED:PORTAL_SELF"]);
  // (PORTAL: presenting the current document confirms what staff had recorded for the guardian.)
  assert.equal((await post(client, "players/consent", { playerId: player, consent: { portal: true, email: false, whatsapp: true }, versions: await versionsMap() })).status, 200);
  assert.equal((await dbEvents(player, g.id)).length, 5, "nothing changed, nothing recorded");
  // Once a document is published it must be presented, here too.
  const doc = await publish(boss, "EMAIL");
  const bare = await post(client, "players/consent", { playerId: player, consent: { portal: true, email: true, whatsapp: true } });
  assert.equal(code(bare), "VERSION_REQUIRED");
  assert.equal((await post(client, "players/consent", { playerId: player, consent: { portal: true, email: true, whatsapp: true }, versions: { email: doc.id } })).status, 200);
  await assertConsistent(player, g.id);
  // Staff cannot use the family endpoint.
  assert.equal((await post(boss, "players/consent", { playerId: player, consent: { portal: false, email: false, whatsapp: false } })).status, 403);
});
test("consent decisions no longer decide who a message reaches: a linked guardian stays a recipient", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  const boss = await owner();
  const preview = async () =>
    JSON.stringify((await post(boss, "communications/preview", { subject: "Hello", body: "A short test message.", playerIds: [player], batchIds: [], allBatches: false, channels: ["EMAIL"], templateId: null })).json);
  assert.ok((await preview()).includes(g.id), "a linked guardian is a recipient with no consent recorded");
  await decide(client, player, [await grant("EMAIL")]);
  assert.ok((await preview()).includes(g.id));
  await decide(client, player, [{ category: "EMAIL", action: "WITHDRAW" }]);
  assert.ok((await preview()).includes(g.id), "withdrawing the recorded consent does not stop the sender from sharing");
  const v = await publish(boss, "EMAIL", true);
  await decide(client, player, [{ category: "EMAIL", action: "GRANT", versionId: v.id }]);
  await publish(boss, "EMAIL", true);
  assert.ok((await preview()).includes(g.id), "a lapsed consent version does not stop it either");
});
test("security events: one per decision, academy-scoped, attributed, and free of children's information", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  const boss = await owner();
  const doc = await publish(boss, "PORTAL", false, "Portal consent text that must not appear in any security event.");
  await decide(client, player, [{ category: "PORTAL", action: "GRANT", versionId: doc.id }, await grant("WHATSAPP")]);
  const next = await publish(boss, "PORTAL", false);
  await decide(client, player, [{ category: "PORTAL", action: "GRANT", versionId: next.id }]);
  await decide(client, player, [{ category: "WHATSAPP", action: "WITHDRAW", reason: "Private reason about my child." }]);
  const rows = (await database().select().from(t.securityEvent).where(eq(t.securityEvent.targetUserId, g.id)));
  assert.deepEqual(rows.map((r) => r.event).sort(), ["CONSENT_GRANTED", "CONSENT_GRANTED", "CONSENT_RENEWED", "CONSENT_WITHDRAWN"]);
  for (const r of rows) {
    assert.equal(r.academyId, "green");
    assert.equal(r.actorId, g.id);
    const text = JSON.stringify(r);
    assert.ok(!text.includes("Consent Player") && !text.includes("Private reason") && !text.includes("Portal consent text") && !text.includes(player), "no child, reason, document text or player id");
    assert.deepEqual(Object.keys(r.detail as object).sort().filter((k) => !["category", "method", "ref", "version"].includes(k)), []);
  }
  const published = (await secEvents("CONSENT_VERSION_PUBLISHED")).filter((e) => (e.detail as { ref?: string }).ref === doc.id);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].detail, { category: "PORTAL", version: doc.version, requireRenewal: false, lapsed: 0, ref: doc.id });
  assert.equal(published[0].actorId, USERS.owner.id);
  // Visible to this academy's owner (redacted by the existing allow-list), not to the other academy.
  const log = (await get(boss, `security-events?event=CONSENT_RENEWED&person=${g.id}`)).json as { events: { label: string; detail: Record<string, unknown>; target: { id: string } | null }[] };
  assert.equal(log.events.length, 1);
  assert.deepEqual(log.events[0].detail, { category: "PORTAL", method: "PORTAL_SELF", ref: log.events[0].detail.ref, version: next.version });
  const blue = (await get(await app.as("blueOwner"), `security-events?person=${g.id}`)).json as { events: unknown[] };
  assert.deepEqual(blue.events, []);
});
test("report: counts per state, who needs to renew, admin only, no contact details", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const boss = await owner();
  const client = await signedIn(g.email);
  const v1 = await publish(boss, "WHATSAPP");
  await decide(client, player, [{ category: "WHATSAPP", action: "GRANT", versionId: v1.id }]);
  const before = (await get(boss, "consent/report")).json as { counts: Record<Cat, Record<string, number>>; renewals: { playerId: string; subjectUserId: string; category: string; status: string; playerName: string; subjectName: string }[]; currentVersions: Record<Cat, number | null>; unrecorded: number };
  assert.ok((before.currentVersions.WHATSAPP ?? 0) >= 1);
  assert.equal(before.renewals.some((r) => r.playerId === player && r.category === "WHATSAPP"), false);
  await publish(boss, "WHATSAPP", false);
  const after = (await get(boss, "consent/report")).json as typeof before;
  const mine = after.renewals.find((r) => r.playerId === player && r.category === "WHATSAPP")!;
  assert.deepEqual([mine.status, mine.subjectUserId, mine.playerName], ["RENEWAL_REQUESTED", g.id, `Consent Player ${player}`]);
  assert.equal(after.counts.WHATSAPP.RENEWAL_REQUESTED, before.counts.WHATSAPP.RENEWAL_REQUESTED + 1);
  assert.ok(after.unrecorded >= 2, "the fixture links carry flags without history and are reported, not hidden");
  assert.ok(!/@example\.test/.test(JSON.stringify(after)));
  assert.equal((await get(client, "consent/report")).status, 403);
});
test("history pages are stable and bounded; nothing is exposed for unlinked or unrelated subjects", async () => {
  const g = await makeGuardian();
  const player = await makePlayer({ guardian: { id: g.id } });
  const client = await signedIn(g.email);
  for (let i = 0; i < 7; i++) {
    assert.equal((await decide(client, player, [i % 2 ? { category: "PORTAL", action: "WITHDRAW" } : await grant("PORTAL")])).status, 200);
  }
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: View = await view(client, player, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    assert.ok(page.events.length <= 3);
    seen.push(...page.events.map((e) => e.id));
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 10);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
  assert.equal((await get(client, `consent/${player}?limit=0`)).status, 422);
  assert.equal((await get(client, `consent/${player}?limit=101`)).status, 422);
  assert.equal((await get(client, `consent/${player}?cursor=@@@`)).status, 400);
});
