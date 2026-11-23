import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import { reportPdf } from "../src/modules/reports/application/pdf";
import { consentForPlayer } from "../src/modules/consent/application/service";
import { listAccessEvents } from "../src/modules/audit/application/access-log";
import { DENIAL_CAP, recordAccess } from "../src/modules/audit/application/record";
import { ACCESS_CATEGORIES, ACCESS_OPERATIONS, cleanResourceId, safeContext } from "../src/modules/audit/domain";
import { CANARY, FIXTURE_PASSWORD, ROLES, ROLE_USER, USERS, addFixtureUser, canaryValues, idsFor, type FixtureUserKey } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, signedIn } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";
/**
 * Phase 7: sensitive-data access auditing. Real HTTP over the real route handlers, plus direct service
 * calls (the point being that the SERVICE records, not the route). Events are compared by counts for a
 * given actor/category/operation, so tests do not depend on each other's history.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("access-audit");
  },
  { timeout: HOOK_TIMEOUT },
);
after(async () => app.stop(), { timeout: HOOK_TIMEOUT });
const A = idsFor("childA");
const B = idsFor("childB");
const BL = idsFor("blue");
const API = "/api/academy";
const as = (key: FixtureUserKey) => app.as(key);
type Ev = typeof t.accessEvents.$inferSelect;
type Filter = { actor?: string; category?: string; operation?: string; outcome?: string; academy?: string; resource?: string };
const where = (f: Filter) =>
  and(
    ...[
      f.actor && eq(t.accessEvents.actorId, f.actor),
      f.category && eq(t.accessEvents.category, f.category),
      f.operation && eq(t.accessEvents.operation, f.operation),
      f.outcome && eq(t.accessEvents.outcome, f.outcome),
      f.academy && eq(t.accessEvents.academyId, f.academy),
      f.resource && eq(t.accessEvents.resourceId, f.resource),
    ].filter(Boolean) as ReturnType<typeof eq>[],
  );
const events = async (f: Filter = {}): Promise<Ev[]> =>
  database().select().from(t.accessEvents).where(where(f)).orderBy(asc(t.accessEvents.createdAt), asc(t.accessEvents.id));
const count = async (f: Filter = {}) => (await events(f)).length;
const newest = async (f: Filter) => (await database().select().from(t.accessEvents).where(where(f)).orderBy(desc(t.accessEvents.createdAt), desc(t.accessEvents.id)).limit(1))[0];
const actorOf = (key: FixtureUserKey, role?: string, academyId = "green"): Actor => ({ id: USERS[key].id, name: "x", academyId, role: role ?? USERS[key].role, timezone: "UTC", academyName: "x" });
const everyCanary = [...canaryValues(CANARY.childA), ...canaryValues(CANARY.childB)].filter((v) => v !== CANARY.childA.name && v !== CANARY.childB.name);
const noContent = (value: unknown, label: string) => {
  const text = JSON.stringify(value);
  for (const secret of everyCanary) assert.ok(!text.includes(secret), `${label} leaked ${secret}`);
};
/** Runs one request and returns the access events it produced for this person and category. */
async function produced(key: FixtureUserKey, run: () => Promise<{ status: number }>, f: Omit<Filter, "actor"> = {}) {
  const before = await count({ ...f, actor: USERS[key].id });
  const response = await run();
  return { response, added: (await count({ ...f, actor: USERS[key].id })) - before };
}
test("pure rules: context is an allow-list, resource ids must look like ours", () => {
  assert.deepEqual(safeContext({ status: 403, reason: "ROLE", count: 4, withdrawn: true, counts: { players: 3, hacked: 9, reports: "x" }, password: "p", note: "child has asthma", nested: { a: 1 } }), { status: 403, reason: "ROLE", count: 4, withdrawn: true, counts: { players: 3 } });
  assert.deepEqual(safeContext(null), {});
  assert.deepEqual(safeContext([1, 2]), {});
  assert.deepEqual(safeContext({ status: 99, count: -1, limit: 1.5, reason: "ANYTHING" }), {});
  assert.equal(cleanResourceId("report-fx-child-alpha"), "report-fx-child-alpha");
  assert.equal(cleanResourceId("00000000-0000-4000-8000-000000000101"), "00000000-0000-4000-8000-000000000101");
  for (const bad of ["", "a b", "x'; drop table", "<script>", "x".repeat(65), 5, null, undefined, "../etc"]) assert.equal(cleanResourceId(bad), null, JSON.stringify(bad));
  assert.ok(ACCESS_CATEGORIES.length === 10 && ACCESS_OPERATIONS.length === 7);
});
test("the workspace payload: exactly one event per load, for every role that can load it, with counts and no content", async () => {
  for (const role of ROLES) {
    const key = ROLE_USER[role];
    const { response, added } = await produced(key, async () => (await as(key)).get(API), { category: "WORKSPACE", outcome: "SUCCESS" });
    assert.equal(response.status, 200, role);
    assert.equal(added, 1, `${role}: one logical access, one event`);
    const e = await newest({ actor: USERS[key].id, category: "WORKSPACE" });
    assert.equal(e.academyId, "green");
    assert.equal(e.actorRole, role);
    assert.equal(e.channel, "GET /");
    assert.match(e.requestId ?? "", /^[0-9a-f-]{36}$/);
    assert.ok(Math.abs(e.createdAt.getTime() - Date.now()) < 120_000);
    assert.equal(e.operation, ["GUARDIAN", "ADULT_PLAYER", "NUTRITION_PRO"].includes(role) ? "LIST" : "BULK", role);
    const counts = (e.context as { counts: Record<string, number> }).counts;
    assert.ok(Number.isInteger(counts.players) && counts.players >= 0, role);
    noContent(e, role);
    assert.ok(!JSON.stringify(e).includes(CANARY.childA.name) && !JSON.stringify(e).includes(USERS.guardian.email), role);
  }
  // A family member's count is their own children only.
  const g = await newest({ actor: USERS.guardian.id, category: "WORKSPACE" });
  assert.equal((g.context as { counts: { players: number } }).counts.players, 1);
  // A payload that reaches staff includes the history; the count of withdrawn items is there for investigators.
  const o = await newest({ actor: USERS.owner.id, category: "WORKSPACE" });
  assert.ok("withdrawn" in (o.context as { counts: object }).counts);
});
test("single records and documents: consent, report PDF, receipt, media, training, security log, MFA overview", async () => {
  const owner = await as("owner");
  const guardian = await as("guardian");
  // Consent history of one player.
  for (const [key, client] of [["owner", owner], ["guardian", guardian]] as const) {
    const { response, added } = await produced(key, () => client.get(`${API}/consent/${A.playerId}`), { category: "CONSENT", operation: "VIEW", outcome: "SUCCESS" });
    assert.equal(response.status, 200, key);
    assert.equal(added, 1, key);
    const e = await newest({ actor: USERS[key].id, category: "CONSENT", operation: "VIEW" });
    assert.deepEqual([e.resourceId, e.playerId, e.channel], [A.playerId, A.playerId, "GET consent/:id"]);
    noContent(e, "consent");
  }
  assert.equal((await produced("owner", () => owner.get(`${API}/consent/report`), { category: "CONSENT", operation: "BULK" })).added, 1);
  // Report PDF.
  for (const [key, client] of [["owner", owner], ["guardian", guardian]] as const) {
    const r = await produced(key, () => client.get(`${API}/reports/${A.reportId}/pdf`), { category: "REPORT", operation: "PDF", outcome: "SUCCESS" });
    assert.equal(r.response.status, 200, key);
    assert.equal(r.added, 1, key);
    const e = await newest({ actor: USERS[key].id, category: "REPORT", operation: "PDF" });
    assert.deepEqual([e.resourceId, e.playerId, e.channel], [A.reportId, A.playerId, "GET reports/:id/pdf"]);
    noContent(e, "pdf");
  }
  // Receipt.
  const rc = await produced("guardian", () => guardian.get(`${API}/fees/${A.paymentId}/receipt`), { category: "FINANCE", outcome: "SUCCESS" });
  assert.equal(rc.response.status, 200);
  assert.equal(rc.added, 1);
  assert.equal((await newest({ actor: USERS.guardian.id, category: "FINANCE" })).resourceId, A.paymentId);
  // Media: the link is not an access to the bytes; reading them is, once.
  const link = await produced("guardian", () => guardian.get(`${API}/media/${A.media.shared}/link`), { category: "MEDIA" });
  assert.equal(link.response.status, 200);
  assert.equal(link.added, 0, "issuing a link is not recorded as an access");
  const url = ((await guardian.get(`${API}/media/${A.media.shared}/link`)).json as { url: string }).url;
  const file = await produced("guardian", () => guardian.get(url), { category: "MEDIA", operation: "DOWNLOAD", outcome: "SUCCESS" });
  assert.equal(file.response.status, 200);
  assert.equal(file.added, 1);
  const me = await newest({ actor: USERS.guardian.id, category: "MEDIA" });
  assert.deepEqual([me.resourceId, me.playerId, me.channel], [A.media.shared, A.playerId, "GET media/:id/file"]);
  assert.ok(!JSON.stringify(me).includes("signature"), "the signed link is not stored");
  // Training workspace.
  const tr = await produced("owner", () => owner.get("/api/training"), { category: "TRAINING", outcome: "SUCCESS" });
  assert.equal(tr.response.status, 200);
  assert.equal(tr.added, 1);
  // Account security: the security log and the MFA readiness list.
  assert.equal((await produced("owner", () => owner.get(`${API}/security-events`), { category: "ACCOUNT_SECURITY", outcome: "SUCCESS" })).added, 1);
  assert.equal((await produced("owner", () => owner.get("/api/auth/account/mfa-policy"), { category: "ACCOUNT_SECURITY", outcome: "SUCCESS" })).added, 1);
  // The history itself.
  assert.equal((await produced("owner", () => owner.get(`${API}/access-events`), { category: "AUDIT_LOG", outcome: "SUCCESS" })).added, 1);
});
test("withdrawn content opened by staff is HISTORICAL; the family never gets it and the denial is recorded", async () => {
  const id = "p7-withdrawn-report";
  const data = { playerId: A.playerId, periodStart: "2027-02-01", periodEnd: "2027-02-28", title: "Withdrawn", summary: "P7-SECRET-SUMMARY", evidence: [], academyName: "x", playerName: CANARY.childA.name, reviewer: null, approvedAt: null };
  await database().insert(t.reports).values({ id, academyId: "green", playerId: A.playerId, version: 5, status: "WITHDRAWN", data });
  const owner = await as("owner");
  const r = await produced("owner", () => owner.get(`${API}/reports/${id}/pdf`), { category: "REPORT", operation: "HISTORICAL" });
  assert.equal(r.response.status, 200);
  assert.equal(r.added, 1);
  const e = await newest({ actor: USERS.owner.id, category: "REPORT", operation: "HISTORICAL" });
  assert.deepEqual([e.outcome, e.resourceId, e.playerId, (e.context as { withdrawn?: boolean }).withdrawn], ["SUCCESS", id, A.playerId, true]);
  assert.ok(!JSON.stringify(e).includes("P7-SECRET-SUMMARY"));
  const g = await produced("guardian", async () => (await as("guardian")).get(`${API}/reports/${id}/pdf`), { category: "REPORT", operation: "PDF", outcome: "DENIED" });
  assert.equal(g.response.status, 404);
  assert.equal(g.added, 1);
});
test("denied access is recorded with the right actor and academy, never with data; successes and denials are not mixed up", async () => {
  // Wrong role.
  const coach = await as("coach");
  const d1 = await produced("coach", () => coach.get(`${API}/consent/${A.playerId}`), { category: "CONSENT", outcome: "DENIED" });
  assert.equal(d1.response.status, 403);
  assert.equal(d1.added, 1);
  const e1 = await newest({ actor: USERS.coach.id, category: "CONSENT", outcome: "DENIED" });
  assert.deepEqual([e1.operation, e1.resourceId, e1.actorRole, e1.academyId, (e1.context as { reason: string; status: number }).reason, (e1.context as { status: number }).status], ["VIEW", A.playerId, "COACH", "green", "ROLE", 403]);
  assert.equal(await count({ actor: USERS.coach.id, category: "CONSENT", outcome: "SUCCESS" }), 0);
  // Another family's report, a guessed id in another academy, a finance user opening a report.
  const g2 = await as("guardian2");
  const d2 = await produced("guardian2", () => g2.get(`${API}/reports/${A.reportId}/pdf`), { category: "REPORT", outcome: "DENIED" });
  assert.equal(d2.response.status, 404);
  assert.equal(d2.added, 1);
  const blue = await as("blueOwner");
  const d3 = await produced("blueOwner", () => blue.get(`${API}/reports/${A.reportId}/pdf`), { category: "REPORT", outcome: "DENIED" });
  assert.equal(d3.response.status, 404);
  assert.equal(d3.added, 1);
  const e3 = await newest({ actor: USERS.blueOwner.id, category: "REPORT", outcome: "DENIED" });
  assert.equal(e3.academyId, "blue", "stamped with the ACTOR's academy, so green's owners never see blue's attempts and vice versa");
  assert.equal(await count({ academy: "green", actor: USERS.blueOwner.id }), 0);
  const fin = await as("finance");
  assert.equal((await produced("finance", () => fin.get(`${API}/reports/${A.reportId}/pdf`), { category: "REPORT", outcome: "DENIED" })).added, 1);
  // Receipts and media.
  assert.equal((await produced("guardian2", () => g2.get(`${API}/fees/${A.paymentId}/receipt`), { category: "FINANCE", outcome: "DENIED" })).added, 1);
  assert.equal((await produced("guardian2", () => g2.get(`${API}/media/${A.media.shared}/link`), { category: "MEDIA", outcome: "DENIED" })).added, 1);
  const forged = await produced("guardian2", () => g2.get(`${API}/media/${A.media.shared}/file?expires=1&signature=${"0".repeat(64)}`), { category: "MEDIA", outcome: "DENIED" });
  assert.equal(forged.response.status, 403);
  assert.equal(forged.added, 1);
  // A garbage id is stored as "no id", never verbatim.
  const junk = await produced("guardian2", () => g2.get(`${API}/reports/${encodeURIComponent("x'; drop table access_event; --")}/pdf`), { category: "REPORT", outcome: "DENIED" });
  assert.equal(junk.added, 1);
  const ej = await newest({ actor: USERS.guardian2.id, category: "REPORT", outcome: "DENIED" });
  assert.equal(ej.resourceId, null);
  assert.ok(!JSON.stringify(ej).includes("drop table"));
  // Anonymous callers have no academy: nothing to attribute, nothing stored.
  const total = await count();
  assert.equal((await app.anonymous().get(`${API}/reports/${A.reportId}/pdf`)).status, 401);
  assert.equal(await count(), total);
  for (const e of await events({ outcome: "DENIED" })) noContent(e, "denial");
});
test("denials are capped per person so invalid-id requests cannot flood the table; the cap leaves one marker", async () => {
  const { id, email } = await addFixtureUser("p7-spammer", [{ academyId: "green", role: "GUARDIAN" }]);
  const client = await signedIn(app, email, FIXTURE_PASSWORD);
  for (let i = 0; i < DENIAL_CAP + 15; i++) assert.equal((await client.get(`${API}/reports/nope-${i}/pdf`)).status, 404);
  const stored = await events({ actor: id, outcome: "DENIED" });
  assert.equal(stored.filter((e) => e.operation !== "THROTTLED").length, DENIAL_CAP, "exactly the cap is itemised");
  const markers = stored.filter((e) => e.operation === "THROTTLED");
  assert.equal(markers.length, 1, "one marker says the rest were not itemised");
  assert.deepEqual(markers[0].context, { limit: DENIAL_CAP, windowMinutes: 10 });
  assert.ok(stored.length <= DENIAL_CAP + 1);
  // Legitimate access by the same person is not capped or affected.
  const ok = await produced("guardian", async () => (await as("guardian")).get(API), { category: "WORKSPACE", outcome: "SUCCESS" });
  assert.equal(ok.added, 1);
});
test("direct service calls are audited exactly like HTTP calls (the service records, not the route)", async () => {
  const owner = actorOf("owner");
  const before = await count({ actor: USERS.owner.id, category: "REPORT", operation: "PDF", outcome: "SUCCESS" });
  await reportPdf(owner, A.reportId);
  assert.equal(await count({ actor: USERS.owner.id, category: "REPORT", operation: "PDF", outcome: "SUCCESS" }), before + 1);
  const e = await newest({ actor: USERS.owner.id, category: "REPORT", operation: "PDF" });
  assert.deepEqual([e.channel, e.requestId], ["service", null], "no request context when called directly");
  const deniedBefore = await count({ actor: USERS.coach.id, category: "CONSENT", outcome: "DENIED" });
  await assert.rejects(() => consentForPlayer(actorOf("coach"), A.playerId, {}), (err: unknown) => err instanceof DomainError && err.status === 403);
  assert.equal(await count({ actor: USERS.coach.id, category: "CONSENT", outcome: "DENIED" }), deniedBefore + 1);
  // Refusals to read the history itself, from every direct caller that is not an owner or admin.
  for (const role of ["COACH", "GUARDIAN", "FINANCE", "NUTRITION_PRO"] as const) {
    await assert.rejects(() => listAccessEvents(actorOf(ROLE_USER[role]), {}), (err: unknown) => err instanceof DomainError && err.status === 403, role);
  }
});
test("who may read the history: owner and admin of this academy only; every refusal is itself recorded; other academies see nothing of it", async () => {
  for (const role of ROLES) {
    const key = ROLE_USER[role];
    const client = await as(key);
    const before = await count({ actor: USERS[key].id, category: "AUDIT_LOG", outcome: "DENIED" });
    const r = await client.get(`${API}/access-events`);
    if (role === "OWNER" || role === "ADMIN") {
      assert.equal(r.status, 200, role);
      assert.ok(Array.isArray((r.json as { events: unknown[] }).events));
    } else {
      assert.equal(r.status, 403, role);
      assert.equal((r.json as { events?: unknown }).events, undefined, role);
      assert.equal(await count({ actor: USERS[key].id, category: "AUDIT_LOG", outcome: "DENIED" }), before + 1, `${role}: the attempt is recorded`);
    }
  }
  assert.equal((await app.anonymous().get(`${API}/access-events`)).status, 401);
  // Academy isolation: blue's owner reads blue's history only, however the filters are chosen.
  const blue = await as("blueOwner");
  await blue.get(API);
  const own = (await blue.get(`${API}/access-events?limit=100`)).json as { events: { actor: { id: string }; player: { id: string } | null }[] };
  assert.ok(own.events.length > 0);
  assert.ok(own.events.every((e) => [USERS.blueOwner.id].includes(e.actor.id) || e.actor.id === USERS.blueOwner.id), "only blue's own events");
  for (const filter of [`actor=${USERS.owner.id}`, `resource=${A.playerId}`, `resource=${A.reportId}`, `category=REPORT&outcome=SUCCESS`]) {
    const r = (await blue.get(`${API}/access-events?${filter}`)).json as { events: { actor: { id: string } }[] };
    assert.ok(r.events.every((e) => e.actor.id === USERS.blueOwner.id), `${filter}: filters cannot widen the scope`);
  }
  const greenView = (await (await as("owner")).get(`${API}/access-events?actor=${USERS.blueOwner.id}`)).json as { events: unknown[] };
  assert.equal(greenView.events.length, 0, "green's owner cannot see blue's people");
  // A deactivated administrator loses the interface at once.
  const { id, email } = await addFixtureUser("p7-admin", [{ academyId: "green", role: "ADMIN" }]);
  const admin = await signedIn(app, email, FIXTURE_PASSWORD);
  assert.equal((await admin.get(`${API}/access-events`)).status, 200);
  await database().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, id));
  assert.ok([401, 403].includes((await admin.get(`${API}/access-events`)).status));
});
test("what the investigation view returns: names only for this academy, an allow-list of fields, no record contents", async () => {
  const owner = await as("owner");
  await (await as("guardian")).get(`${API}/reports/${A.reportId}/pdf`);
  const r = (await owner.get(`${API}/access-events?category=REPORT&actor=${USERS.guardian.id}&limit=5`)).json as { events: Record<string, unknown>[] };
  assert.ok(r.events.length >= 1);
  const e = r.events[0];
  assert.deepEqual(Object.keys(e).sort(), ["actor", "at", "category", "categoryLabel", "channel", "context", "id", "operation", "operationLabel", "outcome", "player", "requestId", "resourceId"]);
  assert.deepEqual(Object.keys(e.actor as object).sort(), ["active", "id", "name", "role"]);
  assert.equal((e.actor as { name: string }).name, USERS.guardian.name);
  assert.equal((e.player as { name: string }).name, CANARY.childA.name, "identifies the child, nothing else about them");
  noContent(r, "access log response");
  assert.ok(!/password|secret|token|totp|hash/i.test(JSON.stringify(r)));
  // Names of people outside this academy are never resolved, even if their id is somehow stored here.
  await recordAccess(database(), { id: USERS.blueOwner.id, academyId: "green", role: "OWNER" }, { category: "REPORT", operation: "VIEW", resourceId: "p7-odd" });
  const odd = (await owner.get(`${API}/access-events?resource=p7-odd`)).json as { events: { actor: { name: string | null } }[] };
  assert.equal(odd.events[0].actor.name, null);
});
test("filters, validation, stable ordering and pagination over a large history (no gaps, no duplicates, bounded reads)", async () => {
  const owner = await as("owner");
  // 2,400 events in one second-buckets of 10 (lots of identical timestamps), three categories, two outcomes.
  await database().execute(sql`
    insert into access_event (id, academy_id, actor_id, actor_role, category, operation, outcome, resource_id, player_id, channel, created_at)
    select 'bulk-' || lpad(i::text, 5, '0'), 'green', ${USERS.admin.id}, 'ADMIN',
      (array['REPORT','NUTRITION','FINANCE'])[1 + i % 3], 'VIEW', case when i % 7 = 0 then 'DENIED' else 'SUCCESS' end,
      'bulk-res-' || (i % 5), ${A.playerId}, 'service',
      timestamp '2031-06-01 00:00:00' + ((i / 10)::text || ' seconds')::interval
    from generate_series(1, 2400) as i`);
  const all = await database().execute(sql`select count(*)::int as n from access_event where actor_id = ${USERS.admin.id} and id like 'bulk-%'`);
  const total = (all.rows[0] as { n: number }).n;
  assert.equal(total, 2400);
  type Page = { events: { id: string; at: string }[]; nextCursor: string | null };
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r = (await owner.get(`${API}/access-events?actor=${USERS.admin.id}&limit=100${cursor ? `&cursor=${cursor}` : ""}`)).json as Page;
    assert.ok(r.events.length <= 100);
    seen.push(...r.events.map((e) => e.id));
    cursor = r.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(seen.filter((id) => id.startsWith("bulk-")).length, 2400, "every event exactly once");
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
  assert.ok(pages >= 24);
  const sorted = [...seen].sort().reverse();
  assert.deepEqual(seen.filter((id) => id.startsWith("bulk-")), sorted.filter((id) => id.startsWith("bulk-")), "newest first; ties broken by id, descending");
  // Filters, singly and combined.
  const q = async (qs: string) => (await owner.get(`${API}/access-events?actor=${USERS.admin.id}&limit=100&${qs}`)).json as Page;
  const denied = await q("outcome=DENIED&category=REPORT");
  assert.ok(denied.events.length > 0);
  const byDb = Number((await database().execute(sql`select count(*)::int as n from access_event where actor_id = ${USERS.admin.id} and outcome='DENIED' and category='REPORT' and id like 'bulk-%'`)).rows[0].n);
  let n = 0;
  let c: string | null = null;
  do {
    const r: Page = await q(`outcome=DENIED&category=REPORT${c ? `&cursor=${c}` : ""}`);
    n += r.events.length;
    c = r.nextCursor;
  } while (c);
  assert.equal(n, byDb);
  assert.equal((await q("resource=bulk-res-3&operation=VIEW")).events.length, 100);
  assert.equal((await q(`from=${encodeURIComponent("2031-06-01T00:00:00.000Z")}&to=${encodeURIComponent("2031-06-01T00:00:00.999Z")}`)).events.length <= 10, true);
  const empty = await q("resource=no-such-thing");
  assert.deepEqual([empty.events.length, empty.nextCursor], [0, null]);
  const window = await q(`from=${encodeURIComponent("2040-01-01T00:00:00.000Z")}`);
  assert.equal(window.events.length, 0);
  // Invalid input is refused, not guessed at.
  for (const bad of ["category=EVERYTHING", "operation=PEEK", "outcome=MAYBE", "limit=0", "limit=101", "limit=abc", "from=yesterday", "to=nope", `resource=${"x".repeat(65)}`, "actor="]) {
    const r = await owner.get(`${API}/access-events?${bad}`);
    assert.ok([400, 422].includes(r.status), `${bad} -> ${r.status}`);
  }
  assert.equal((await owner.get(`${API}/access-events?cursor=not-a-cursor`)).status, 400);
  assert.equal((await owner.get(`${API}/access-events?cursor=${Buffer.from("garbage").toString("base64url")}`)).status, 400);
});
test("integrity: the history cannot be changed or removed through the application or the database", async () => {
  const [e] = await events({ category: "WORKSPACE" });
  const names = (pattern: RegExp) => (err: unknown) => pattern.test(`${err} ${(err as { cause?: unknown }).cause}`);
  await assert.rejects(() => database().update(t.accessEvents).set({ outcome: "DENIED" }).where(eq(t.accessEvents.id, e.id)), names(/append-only/));
  await assert.rejects(() => database().delete(t.accessEvents).where(eq(t.accessEvents.id, e.id)), names(/append-only/));
  await assert.rejects(() => database().execute(sql`truncate access_event`), names(/append-only/));
  await assert.rejects(() => database().execute(sql`delete from access_event`), names(/append-only/));
  assert.equal((await events({ category: "WORKSPACE" }))[0].outcome, e.outcome);
  // No route changes or deletes it.
  const owner = await as("owner");
  for (const route of ["access-events", "access-events/delete", "access-events/update", "access/delete"]) {
    const r = await owner.post(`${API}/${route}`, { id: e.id });
    assert.equal(r.status, 404, route);
  }
  assert.ok(await count());
});
test("failure policy: a successful read needs its event (fail-closed); a refusal stays a refusal even if it cannot be recorded", async () => {
  const owner = await as("owner");
  const guardian2 = await as("guardian2");
  const before = await count();
  await database().execute(sql`alter table access_event rename to access_event_offline`);
  try {
    // Reads that would succeed fail, and return nothing.
    const bootstrap = await owner.get(API);
    assert.equal(bootstrap.status, 500);
    assert.ok(!bootstrap.text.includes(CANARY.childA.name) && !bootstrap.text.includes("players"), "no data left the server");
    const pdf = await owner.get(`${API}/reports/${A.reportId}/pdf`);
    assert.equal(pdf.status, 500);
    assert.notEqual(pdf.headers.get("content-type"), "application/pdf");
    assert.equal((await owner.get(`${API}/consent/${A.playerId}`)).status, 500);
    assert.equal((await owner.get(`${API}/access-events`)).status, 500);
    assert.equal((await owner.get("/api/training")).status, 500);
    // A refusal is still the refusal (not a 500), and the failed record is reported to the server log.
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      const r = await guardian2.get(`${API}/reports/${A.reportId}/pdf`);
      assert.equal(r.status, 404);
    } finally {
      console.error = original;
    }
    assert.ok(logged.some((l) => l.includes("Access audit (denial) write failed")), "never swallowed silently");
  } finally {
    await database().execute(sql`alter table access_event_offline rename to access_event`);
  }
  assert.equal(await count(), before, "nothing was half-recorded");
  assert.equal((await owner.get(API)).status, 200, "and service resumes when the table is back");
});
test("a read that fails after its event was written leaves no event: the record and the read share one transaction", async () => {
  const [media] = await database().select().from(t.mediaAssets).where(eq(t.mediaAssets.id, A.media.shared));
  const id = crypto.randomUUID();
  await database().insert(t.mediaAssets).values({ ...media, id, storageKey: "missing/never-stored" });
  const guardian = await as("guardian");
  const url = ((await guardian.get(`${API}/media/${id}/link`)).json as { url: string }).url;
  const before = await count({ resource: id });
  const r = await guardian.get(url);
  assert.ok(r.status >= 400, `the read failed (status ${r.status})`);
  assert.notEqual(r.headers.get("content-type"), "image/png");
  assert.equal(await count({ resource: id }), before, "no SUCCESS event for bytes that were never delivered");
});
test("concurrent access: every request is recorded once, with its own id, and the order is stable", async () => {
  const owner = await as("owner");
  const before = await count({ actor: USERS.owner.id, category: "WORKSPACE" });
  const responses = await Promise.all(Array.from({ length: 20 }, () => owner.clone().get(API)));
  assert.ok(responses.every((r) => r.status === 200));
  const mine = await events({ actor: USERS.owner.id, category: "WORKSPACE" });
  assert.equal(mine.length, before + 20);
  const fresh = mine.slice(-20);
  assert.equal(new Set(fresh.map((e) => e.id)).size, 20);
  assert.equal(new Set(fresh.map((e) => e.requestId)).size, 20, "each request has its own correlation id");
  const sortedTwice = [...mine].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
  assert.deepEqual(mine.map((e) => e.id), sortedTwice.map((e) => e.id));
});
test("cost: writing an event is cheap, and the common lookups are served by indexes", async () => {
  const who = { id: "p7-timer", academyId: "green", role: "OWNER" };
  const started = performance.now();
  for (let i = 0; i < 200; i++) await recordAccess(database(), who, { category: "REPORT", operation: "VIEW", resourceId: `p7-t-${i}` });
  const average = (performance.now() - started) / 200;
  console.log(`access event write: ${average.toFixed(2)} ms average over 200 sequential inserts (${app.database})`);
  assert.ok(average < 100, `average ${average} ms`);
  if (app.database !== "pglite") {
    const plan = await database().execute(sql`explain select * from access_event where academy_id = 'green' order by created_at desc, id desc limit 26`);
    const text = JSON.stringify(plan.rows);
    assert.ok(/Index/i.test(text), text);
  }
});
test("regression: the other roles still see exactly what they saw before (auditing adds no data to any payload)", async () => {
  const guardian = (await (await as("guardian")).get(API)).json as Record<string, unknown>;
  assert.ok(!("accessEvents" in guardian) && !("access" in guardian));
  const g2 = (await (await as("guardian2")).get(`${API}/consent/${B.playerId}`)) as { status: number };
  assert.equal(g2.status, 200);
  assert.equal(code({ json: (await (await as("blueGuardian")).get(`${API}/reports/${BL.reportId}/pdf`)).json }), undefined);
});
