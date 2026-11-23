import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { feedFor } from "../src/modules/calendar/application/feed";
import { GET as feedRoute } from "../src/app/api/calendar/[token]/route";
import { buildIcs, foldLine, icsText } from "../src/modules/calendar/ics";
import { sessionMessage } from "../src/modules/calendar/session-message";
import { idsFor, USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import type { TestClient } from "./helpers/client";

/**
 * Free calendar links and "tell everyone", over real HTTP and real rows. What is proved:
 *   - the calendar text is valid (escaping, folding, CRLF) and the message names time, place and drills;
 *   - a calendar link shows each person only what the app already shows them, with the drills, and never a private note,
 *     objective, recap or another child's name; it is stored only as a hash; a new link replaces the old one; it ends with
 *     the membership;
 *   - the lists of people to tell respect consent (no contact shown without it), scope (a coach sees only their own
 *     sessions) and role (a parent cannot ask), and only a PUBLISHED report can be shared.
 */
const A = idsFor("childA"); // guardian 1 (e-mail consent only), batch green-main, coach `coach`
const B = idsFor("childB"); // guardian 2 (WhatsApp consent only), batch green-other, coach `headCoach`
const route = (p: string) => `/api/academy/${p}`;
let app: Harness;
const as = (k: Parameters<Harness["as"]>[0]) => app.as(k);
async function link(client: TestClient): Promise<string> {
  const r = await client.post(route("calendar/link"), {});
  assert.equal(r.status, 200, r.text);
  const token = (r.json as { token: string }).token;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  return token;
}

before(async () => {
  app = await startHarness("calendar-sharing");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app.stop();
}, { timeout: HOOK_TIMEOUT });

test("calendar text: escaped, folded at 75 octets, CRLF, and a broken time is dropped", () => {
  assert.equal(icsText("a,b;c\\d\ne"), "a\\,b\\;c\\\\d\\ne");
  for (const line of foldLine(`DESCRIPTION:${"é".repeat(120)}`).split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75);
  const text = buildIcs("Academy, training", [
    { uid: "s1@sportozen", title: "Training", startAt: "2026-11-20T11:30:00.000Z", endAt: "2026-11-20T13:00:00.000Z", description: "Drills:\n1. Footwork (10 min)" },
    { uid: "bad", title: "x", startAt: "nope", endAt: "2026-11-20T13:00:00Z" },
  ]);
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n") && text.endsWith("END:VCALENDAR\r\n"));
  assert.match(text, /DTSTART:20261120T113000Z/);
  assert.match(text, /X-WR-CALNAME:Academy\\, training/);
  assert.equal(text.match(/BEGIN:VEVENT/g)?.length, 1);
});

test("message: the time in the session's zone, the place and the drills; a cancellation lists none", () => {
  const session = { status: "PUBLISHED", title: "Footwork", startAt: "2026-11-20T11:30:00.000Z", endAt: "2026-11-20T13:00:00.000Z", timezone: "Asia/Kolkata", location: "Court 2", drills: [{ name: "Footwork", minutes: 10 }] };
  const m = sessionMessage({ academyName: "Test", session, person: { name: "Asha Rao", staff: false, children: ["Rishi"] } });
  assert.match(m.text, /17:00–18:30 \(Asia\/Kolkata\)/);
  assert.match(m.text, /For: Rishi/);
  assert.match(m.text, /1\. Footwork \(10 min\)/);
  const c = sessionMessage({ academyName: "Test", session: { ...session, status: "CANCELLED" }, person: { name: "Coach K", staff: true, children: [] } });
  assert.match(c.text, /cancelled/);
  assert.ok(!c.text.includes("Drills:"));
});

test("a coach's link shows only their own session, with the drills and no private content", { timeout: TEST_TIMEOUT }, async () => {
  const token = await link(await as("coach"));
  const text = (await feedFor(token))!;
  assert.ok(text, "feed");
  assert.match(text, new RegExp(`UID:${A.sessionId}@sportozen`));
  assert.match(text, /Footwork \(10 min\)/);
  assert.ok(!text.includes(B.sessionId), "another coach's session");
  for (const secret of ["CANARY-SESSION-OBJECTIVE", "CANARY-SESSION-NOTE", "CANARY-SESSION-RECAP", "CANARY-REVIEW", "Canary ALPHA", "Canary BRAVO"])
    assert.ok(!text.includes(secret), secret);
  assert.match(text, /1 player/);
});

test("the owner's link shows every session of the academy, and only that academy", { timeout: TEST_TIMEOUT }, async () => {
  const text = (await feedFor(await link(await as("owner"))))!;
  assert.match(text, new RegExp(`UID:${A.sessionId}@sportozen`));
  assert.match(text, new RegExp(`UID:${B.sessionId}@sportozen`));
  assert.ok(!text.includes(idsFor("blue").sessionId), "another academy's session");
});

test("a parent's link shows only their own child's sessions and events, by first name", { timeout: TEST_TIMEOUT }, async () => {
  const text = (await feedFor(await link(await as("guardian"))))!;
  assert.match(text, new RegExp(`UID:${A.sessionId}@sportozen`));
  assert.ok(!text.includes(B.sessionId), "another family's session");
  assert.match(text, /CANARY-EVENT-ALPHA/);
  assert.ok(!text.includes("CANARY-EVENT-BRAVO"));
  for (const secret of ["CANARY-SESSION-OBJECTIVE", "CANARY-SESSION-NOTE", "CANARY-SESSION-RECAP", "ALPHA-NOTES", "CANARY-NOTES", "BRAVO"])
    assert.ok(!text.includes(secret), secret);
});

test("only a hash is stored, a new link replaces the old one, and a wrong link gives nothing", { timeout: TEST_TIMEOUT }, async () => {
  const coach = await as("coach");
  const first = await link(coach),
    second = await link(coach);
  assert.notEqual(first, second);
  assert.equal(await feedFor(first), null);
  assert.ok(await feedFor(second));
  const stored = await database().select().from(t.verification);
  assert.ok(stored.every((r) => !r.identifier.includes(second) && !r.value.includes(second)), "secret stored in the clear");
  assert.equal(stored.filter((r) => r.identifier.startsWith("calendar-feed:") && r.value.includes(USERS.coach.id)).length, 1);
  for (const bad of ["x".repeat(43), "short", "../../etc/passwd"]) assert.equal(await feedFor(bad), null);
  const miss = await feedRoute(new Request("http://x/api/calendar/short"), { params: Promise.resolve({ token: "short.ics" }) });
  assert.equal(miss.status, 404);
  const ok = await feedRoute(new Request(`http://x/api/calendar/${second}.ics`), { params: Promise.resolve({ token: `${second}.ics` }) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type") ?? "", /text\/calendar/);
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
});

test("the link ends with the membership, and roles without a calendar are refused", { timeout: TEST_TIMEOUT }, async () => {
  const token = await link(await as("guardian"));
  assert.ok(await feedFor(token));
  await database().update(t.memberships).set({ active: false }).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.userId, USERS.guardian.id)));
  try {
    assert.equal(await feedFor(token), null);
  } finally {
    await database().update(t.memberships).set({ active: true }).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.userId, USERS.guardian.id)));
  }
  const r = await (await as("finance")).post(route("calendar/link"), {});
  assert.equal(r.status, 403);
});

type Share = { people: { userId: string; staff: boolean; email: string | null; phone: string | null; children: string[] }[]; session: { drills: unknown[] } };
test("who to tell about a session: the coach and the parents, each with their own e-mail and saved number", { timeout: TEST_TIMEOUT }, async () => {
  const r = await (await as("owner")).post(route("communications/session-share"), { kind: "SESSION", id: A.sessionId });
  assert.equal(r.status, 200, r.text);
  const share = r.json as Share;
  const coach = share.people.find((p) => p.staff)!,
    parent = share.people.find((p) => p.userId === USERS.guardian.id)!;
  assert.equal(coach.userId, USERS.coach.id);
  assert.equal(parent.email, USERS.guardian.email);
  const [account] = await database().select().from(t.user).where(eq(t.user.id, USERS.guardian.id));
  assert.equal(parent.phone, account.phone ?? null, "the number saved on the account, or none");
  assert.equal(share.session.drills.length, 1);
  assert.ok(!share.people.some((p) => p.userId === USERS.guardian2.id), "another family");
});

test("a parent is listed with their contact whatever the old consent flags say (no consent record is needed to share)", { timeout: TEST_TIMEOUT }, async () => {
  const where = and(eq(t.guardianLinks.academyId, "green"), eq(t.guardianLinks.playerId, A.playerId), eq(t.guardianLinks.userId, USERS.guardian.id));
  const [before] = await database().select().from(t.guardianLinks).where(where);
  await database().update(t.guardianLinks).set({ consent: { portal: true, email: false, whatsapp: false } }).where(where);
  try {
    const r = await (await as("owner")).post(route("communications/session-share"), { kind: "SESSION", id: A.sessionId });
    const parent = (r.json as Share).people.find((p) => p.userId === USERS.guardian.id)!;
    assert.equal(parent.email, USERS.guardian.email);
  } finally {
    await database().update(t.guardianLinks).set({ consent: before.consent }).where(where);
  }
});

test("scope and role: a coach cannot ask about another coach's session, and a parent cannot ask at all", { timeout: TEST_TIMEOUT }, async () => {
  const coach = await as("coach");
  assert.equal((await coach.post(route("communications/session-share"), { kind: "SESSION", id: B.sessionId })).status, 404);
  assert.equal((await coach.post(route("communications/session-share"), { kind: "SESSION", id: A.sessionId })).status, 200);
  const guardian = await as("guardian");
  assert.equal((await guardian.post(route("communications/session-share"), { kind: "SESSION", id: A.sessionId })).status, 403);
  assert.equal((await (await as("owner")).post(route("communications/session-share"), { kind: "SESSION", id: "no-such-session" })).status, 404);
});

test("an event can be shared the same way", { timeout: TEST_TIMEOUT }, async () => {
  const r = await (await as("owner")).post(route("communications/session-share"), { kind: "EVENT", id: `event-${A.playerId}` });
  assert.equal(r.status, 200, r.text);
  assert.ok((r.json as Share).people.some((p) => p.userId === USERS.guardian.id));
});

test("only a published report can be shared, and only with its own child's parents", { timeout: TEST_TIMEOUT }, async () => {
  const owner = await as("owner");
  // The fixture report is a draft revision of a published one: nothing to send until it is published again.
  assert.equal((await owner.post(route("communications/report-share"), { id: A.reportId })).status, 409);
  await database().update(t.reports).set({ status: "PUBLISHED" }).where(and(eq(t.reports.academyId, "green"), eq(t.reports.id, A.reportId)));
  try {
    const r = await owner.post(route("communications/report-share"), { id: A.reportId });
    assert.equal(r.status, 200, r.text);
    const share = r.json as { people: { userId: string }[] };
    assert.deepEqual(share.people.map((p) => p.userId), [USERS.guardian.id]);
    assert.equal((await (await as("guardian")).post(route("communications/report-share"), { id: A.reportId })).status, 403);
  } finally {
    await database().update(t.reports).set({ status: "DRAFT" }).where(and(eq(t.reports.academyId, "green"), eq(t.reports.id, A.reportId)));
  }
});
