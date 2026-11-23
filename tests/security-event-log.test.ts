import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { recordSecurityEvent } from "../src/modules/identity/security-events";
import { safeDetail } from "../src/modules/identity/security-event-log";
import {
  SECURITY_EVENT_META,
  SECURITY_EVENT_NAMES,
} from "../src/modules/identity/security-event-meta";
import {
  FIXTURE_PASSWORD,
  ROLES,
  ROLE_USER,
  USERS,
  addFixtureUser,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, REPO_ROOT } from "./helpers/paths";
import {
  CHANGE,
  NEW_PASSWORD,
  newMember,
  reset,
  secretBearingRows,
  signedIn as signIn,
  type ResetResult,
} from "./helpers/accounts";
/**
 * Phase 3: the account-security log (GET /api/academy/security-events).
 * Who may read it, which academy it covers, what may leave the database, how it is filtered and
 * paged, and that nothing in the application can change or delete it.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("security-event-log");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const PATH = "/api/academy/security-events";
type Person = { id: string; name: string; role: string } | null;
type Event = {
  id: string;
  event: string;
  label: string;
  outcome: string | null;
  at: string;
  actor: Person;
  target: Person;
  detail: Record<string, unknown>;
};
type Page = { events: Event[]; nextCursor: string | null };
const page = (r: { json: unknown }) => r.json as Page;
const ownerClient = () => signIn(app, USERS.owner.email);
const blueOwner = () => signIn(app, USERS.blueOwner.email);
test("only owners and admins may read the log; every other role and anonymous callers are refused", async () => {
  // Make sure there is something to protect.
  await recordSecurityEvent(database(), {
    event: "PASSWORD_CHANGED",
    academyId: "green",
    targetUserId: USERS.owner.id,
  });
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    const r = await client.get(PATH);
    if (role === "OWNER" || role === "ADMIN") {
      assert.equal(r.status, 200, `${role}: ${r.text.slice(0, 120)}`);
      assert.ok(page(r).events.length > 0);
    } else {
      assert.equal(r.status, 403, role);
      assert.deepEqual(r.json, { error: "Your role cannot perform this action." });
    }
  }
  assert.equal((await app.anonymous().get(PATH)).status, 401);
});
test("an academy sees its own events and no one else's, including events about people it shares with nobody", async () => {
  const green = await newMember("COACH", "green", "log");
  const blue = await newMember("COACH", "blue", "log");
  await recordSecurityEvent(database(), {
    event: "MFA_ENABLED",
    academyId: "green",
    targetUserId: green.id,
    detail: { reason: "GREEN-CANARY" },
  });
  await recordSecurityEvent(database(), {
    event: "MFA_ENABLED",
    academyId: "blue",
    targetUserId: blue.id,
    detail: { reason: "BLUE-CANARY" },
  });
  // Rows written before academies were stamped (no academy): shown only for a person who is a
  // member of exactly one academy, and only to that academy.
  await database().insert(t.securityEvent).values([
    { id: "legacy-green", event: "PASSWORD_CHANGED", targetUserId: green.id, detail: { revokedSessions: 1 } },
    { id: "legacy-blue", event: "PASSWORD_CHANGED", targetUserId: blue.id, detail: { revokedSessions: 7 } },
    { id: "legacy-nobody", event: "SIGN_IN_LOCKED", detail: { failures: 10 } },
  ]);
  // A person who belongs to both academies (D7): their own sign-in and credential events (no academy of their own) are
  // shown to EACH academy they are an active member of, so belonging to several does not hide them from all of
  // them. Anything else without an academy (an operator's written reason, say) still surfaces in neither.
  const both = await addFixtureUser("log-both", [
    { academyId: "green", role: "COACH" },
    { academyId: "blue", role: "COACH" },
  ]);
  await database().insert(t.securityEvent).values([
    { id: "legacy-both", event: "PASSWORD_CHANGED", targetUserId: both.id, detail: {} },
    { id: "legacy-both-operator", event: "OPERATOR_RECOVERY", targetUserId: both.id, detail: { reason: "OPERATOR-REASON-CANARY" } },
  ]);
  // ...but only while they are an ACTIVE member there
  const left = await addFixtureUser("log-left", [
    { academyId: "green", role: "COACH" },
    { academyId: "blue", role: "COACH", active: false },
  ]);
  await database().insert(t.securityEvent).values({ id: "legacy-left", event: "PASSWORD_CHANGED", targetUserId: left.id, detail: {} });
  const g = await (await ownerClient()).get(`${PATH}?limit=100`);
  const b = await (await blueOwner()).get(`${PATH}?limit=100`);
  const ids = (r: { json: unknown }) => page(r).events.map((e) => e.id);
  assert.ok(g.text.includes("GREEN-CANARY") && !g.text.includes("BLUE-CANARY"));
  assert.ok(b.text.includes("BLUE-CANARY") && !b.text.includes("GREEN-CANARY"));
  assert.ok(ids(g).includes("legacy-green") && !ids(g).includes("legacy-blue"));
  assert.ok(ids(b).includes("legacy-blue") && !ids(b).includes("legacy-green"));
  assert.ok(ids(g).includes("legacy-both") && ids(b).includes("legacy-both"), "a two-academy person's own sign-in event is visible to both");
  assert.ok(ids(g).includes("legacy-left") && !ids(b).includes("legacy-left"), "and only where their membership is active");
  for (const hidden of ["legacy-both-operator", "legacy-nobody"]) {
    assert.ok(!ids(g).includes(hidden) && !ids(b).includes(hidden), hidden);
  }
  assert.ok(!g.text.includes("OPERATOR-REASON-CANARY") && !b.text.includes("OPERATOR-REASON-CANARY"));
  // Names appear only for members of the viewing academy: blue's coach is just "unknown" to green.
  const blueRow = page(await (await ownerClient()).get(`${PATH}?person=${blue.id}`));
  assert.equal(blueRow.events.length, 0, "filtering by an outsider returns nothing, not an error");
  // A caller cannot choose the academy: the parameter is ignored.
  const sneaky = await (await ownerClient()).get(`${PATH}?academyId=blue&academy=blue&limit=100`);
  assert.ok(!sneaky.text.includes("BLUE-CANARY"));
});
test("people are named only if they belong to the viewing academy", async () => {
  const insider = await newMember("COACH", "green", "names");
  const outsider = await newMember("COACH", "blue", "names");
  await database().insert(t.securityEvent).values({
    id: "names-1",
    event: "ADMIN_RESET_DENIED",
    academyId: "green",
    actorId: outsider.id,
    targetUserId: insider.id,
    detail: {},
  });
  const seen = page(await (await ownerClient()).get(`${PATH}?person=${insider.id}&event=ADMIN_RESET_DENIED`));
  const row = seen.events.find((e) => e.id === "names-1")!;
  assert.equal(row.actor, null, "another academy's member is not named");
  assert.equal(row.target?.id, insider.id);
  assert.ok(!JSON.stringify(seen).includes(`Fixture ${outsider.id}`));
});
test("events are stamped with the academy when written, so self-service events reach the right owners", async () => {
  const member = await newMember("COACH", "green", "stamp");
  const client = await signIn(app, member.email);
  const replacement = NEW_PASSWORD();
  const changed = await client.post(CHANGE, { currentPassword: FIXTURE_PASSWORD, newPassword: replacement });
  assert.equal(changed.status, 200);
  const wrong = await (await signIn(app, member.email, replacement)).post(CHANGE, { currentPassword: "Wrong-Current-Password-1", newPassword: NEW_PASSWORD() });
  assert.equal(wrong.status, 400);
  const stored = await database().select().from(t.securityEvent).where(eq(t.securityEvent.targetUserId, member.id));
  assert.ok(stored.length >= 2);
  for (const row of stored) assert.equal(row.academyId, "green", row.event);
  const seen = page(await (await ownerClient()).get(`${PATH}?person=${member.id}`));
  assert.deepEqual(
    new Set(seen.events.map((e) => e.event)),
    new Set(["PASSWORD_CHANGED", "PASSWORD_CHANGE_FAILED"]),
  );
  const row = seen.events.find((e) => e.event === "PASSWORD_CHANGED")!;
  assert.equal(row.target?.id, member.id);
  assert.equal(row.actor?.id, member.id);
  assert.equal(row.target?.name, `Fixture ${member.id}`);
  assert.equal(row.outcome, "success");
  assert.equal(seen.events.find((e) => e.event === "PASSWORD_CHANGE_FAILED")!.outcome, "failed");
  // Blue cannot see them.
  assert.equal(page(await (await blueOwner()).get(`${PATH}?person=${member.id}`)).events.length, 0);
});
test("the log never carries credentials: stored extras are dropped and real flows leave nothing secret", async () => {
  const target = await newMember("FINANCE", "green", "redact");
  const owner = await ownerClient();
  const issued = await reset(owner, target.id, { resetAuthenticator: true });
  assert.equal(issued.status, 200, issued.text);
  const temporary = (issued.json as ResetResult).temporaryPassword;
  // Something a future caller might store by mistake.
  await recordSecurityEvent(database(), {
    event: "ADMIN_PASSWORD_RESET",
    academyId: "green",
    actorId: USERS.owner.id,
    targetUserId: target.id,
    detail: {
      reason: "visible reason text",
      password: "LEAK-password",
      newPassword: "LEAK-new",
      token: "LEAK-token",
      secret: "LEAK-secret",
      totpSecret: "LEAK-totp",
      recoveryCodes: ["LEAK-code"],
      hash: "LEAK-hash",
      nested: { password: "LEAK-nested" },
      revokedSessions: "not a number",
    },
  });
  const r = await owner.get(`${PATH}?person=${target.id}&limit=100`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("visible reason text"));
  assert.ok(!/LEAK-/.test(r.text), "stored extras never leave the database");
  assert.ok(!r.text.includes(temporary), "the temporary password is never in the log");
  const hash = (await database().select().from(t.account).where(eq(t.account.userId, target.id)))[0].password!;
  assert.ok(!r.text.includes(hash));
  const allowed = new Set(["reason", "expiresAt", "revokedSessions", "authenticatorRemoved", "wasTemporary", "generated", "failures", "operator", "fromRole", "toRole"]);
  for (const e of page(r).events)
    for (const key of Object.keys(e.detail)) assert.ok(allowed.has(key), key);
  for (const e of page(r).events)
    assert.deepEqual(Object.keys(e).sort(), ["actor", "at", "detail", "event", "id", "label", "outcome", "target"], "no raw columns such as academyId");
  for (const p of page(r).events.flatMap((e) => [e.actor, e.target]).filter(Boolean))
    assert.deepEqual(Object.keys(p!).sort(), ["active", "id", "name", "role"], "no e-mail addresses or hashes for people");
  assert.ok(!/@example\.test/.test(r.text), "no e-mail addresses");
  // And the database tables the log reads hold none of the passwords used here either.
  assert.ok(!(await secretBearingRows()).includes(temporary));
});
test("safeDetail keeps only known keys of the right type", () => {
  assert.deepEqual(safeDetail(null), {});
  assert.deepEqual(safeDetail([1, 2]), {});
  assert.deepEqual(safeDetail("password"), {});
  assert.deepEqual(
    safeDetail({ reason: "r".repeat(900), revokedSessions: 2.5, failures: 3, authenticatorRemoved: "yes", expiresAt: "not a date", operator: "x".repeat(200), token: "t" }),
    { reason: "r".repeat(500), failures: 3, operator: "x".repeat(80) },
  );
});
test("filters: by event, outcome, person and time; bad values are rejected", async () => {
  const owner = await ownerClient();
  const a = await newMember("COACH", "green", "filter");
  const b = await newMember("COACH", "green", "filter");
  const db = database();
  const base = Date.parse("2031-05-01T10:00:00Z");
  const put = (id: string, event: string, who: string, minutes: number) =>
    db.insert(t.securityEvent).values({ id, event, academyId: "green", targetUserId: who, createdAt: new Date(base + minutes * 60000), detail: {} });
  await put("f1", "PASSWORD_CHANGED", a.id, 0);
  await put("f2", "SIGN_IN_LOCKED", a.id, 10);
  await put("f3", "PASSWORD_CHANGED", b.id, 20);
  await put("f4", "ADMIN_RESET_DENIED", b.id, 30);
  const get = async (q: string) => page(await owner.get(`${PATH}?${q}`)).events.map((e) => e.id);
  const scope = `from=${encodeURIComponent("2031-05-01T00:00:00Z")}&to=${encodeURIComponent("2031-05-02T00:00:00Z")}`;
  assert.deepEqual(await get(scope), ["f4", "f3", "f2", "f1"], "newest first");
  assert.deepEqual(await get(`${scope}&event=PASSWORD_CHANGED`), ["f3", "f1"]);
  assert.deepEqual(await get(`${scope}&outcome=locked`), ["f2"]);
  assert.deepEqual(await get(`${scope}&outcome=denied`), ["f4"]);
  assert.deepEqual(await get(`${scope}&person=${a.id}`), ["f2", "f1"]);
  assert.deepEqual(await get(`${scope}&person=${b.id}&event=PASSWORD_CHANGED`), ["f3"]);
  assert.deepEqual(await get(`from=${encodeURIComponent("2031-05-01T10:15:00Z")}&to=${encodeURIComponent("2031-05-01T10:30:00Z")}`), ["f4", "f3"], "both ends inclusive");
  assert.deepEqual(await get(`${scope}&event=PASSWORD_CHANGED&outcome=locked`), [], "filters combine");
  for (const bad of ["event=DROP_TABLE", "outcome=maybe", "limit=0", "limit=101", "limit=abc", "from=yesterday", "to=", "person="]) {
    const r = await owner.get(`${PATH}?${bad}`);
    assert.equal(r.status, 422, bad);
  }
  assert.equal((await owner.get(`${PATH}?cursor=@@@`)).status, 400);
  assert.equal((await owner.get(`${PATH}?cursor=${Buffer.from("nonsense").toString("base64url")}`)).status, 400);
  // A value written by a newer build is shown as text, with no outcome.
  await db.insert(t.securityEvent).values({ id: "f5", event: "<b>FUTURE_EVENT</b>", academyId: "green", createdAt: new Date(base + 40 * 60000), detail: {} });
  const future = page(await owner.get(`${PATH}?${scope}&limit=1`)).events[0];
  assert.deepEqual([future.id, future.label, future.outcome], ["f5", "<b>FUTURE_EVENT</b>", null]);
});
test("pagination walks the whole log exactly once, including events with identical timestamps", async () => {
  const owner = await ownerClient();
  const who = await newMember("COACH", "green", "paging");
  const instant = new Date("2032-01-01T00:00:00.000Z");
  const rows = Array.from({ length: 57 }, (_, i) => ({
    id: `p-${String(i).padStart(3, "0")}`,
    event: "PASSWORD_CHANGED",
    academyId: "green",
    targetUserId: who.id,
    // Groups of six share a timestamp, so ordering must fall back to the id.
    createdAt: new Date(instant.getTime() + Math.floor(i / 6) * 1000),
    detail: {},
  }));
  await database().insert(t.securityEvent).values(rows);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const r = await owner.get(`${PATH}?person=${who.id}&limit=10${cursor ? `&cursor=${cursor}` : ""}`);
    assert.equal(r.status, 200);
    const body: Page = page(r);
    assert.ok(body.events.length <= 10);
    seen.push(...body.events.map((e) => e.id));
    cursor = body.nextCursor;
    pages++;
  } while (cursor && pages < 20);
  assert.equal(pages, 6);
  assert.equal(seen.length, 57);
  assert.equal(new Set(seen).size, 57, "no repeats");
  assert.deepEqual(seen, [...rows].sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1)).map((r) => r.id));
  // Default page size and the cap.
  assert.equal(page(await owner.get(`${PATH}?person=${who.id}`)).events.length, 25);
  assert.equal(page(await owner.get(`${PATH}?person=${who.id}&limit=100`)).events.length, 57);
  // A cursor is only a position: it cannot be used to read another academy's rows.
  const stolen = page(await owner.get(`${PATH}?person=${who.id}&limit=1`)).nextCursor!;
  const blue = await (await blueOwner()).get(`${PATH}?cursor=${stolen}&limit=100`);
  assert.equal(blue.status, 200);
  assert.ok(!blue.text.includes(who.id));
});
test("no route, method or code path in the application can change or delete a security event", async () => {
  const owner = await ownerClient();
  const before = JSON.stringify(await database().select().from(t.securityEvent).orderBy(t.securityEvent.id));
  const victim = (await database().select().from(t.securityEvent).limit(1))[0];
  for (const route of ["security-events", `security-events/${victim.id}`, "security-events/delete", "security-events/clear", "security-events/save"]) {
    const r = await owner.post(`/api/academy/${route}`, { id: victim.id, event: "TAMPERED", detail: {} });
    assert.equal(r.status, 404, route);
  }
  for (const method of ["DELETE", "PUT", "PATCH"]) {
    const r = await fetch(`${app.origin}${PATH}/${victim.id}`, { method, headers: { cookie: owner.cookieHeader, origin: app.origin, "x-test-peer": owner.address } });
    assert.ok(r.status === 404 || r.status === 405, `${method} ${r.status}`);
  }
  assert.equal(JSON.stringify(await database().select().from(t.securityEvent).orderBy(t.securityEvent.id)), before);
  // The reader and the writer only ever select/insert (a source-level guard against a future edit
  // adding an update or delete path for this table).
  for (const file of ["security-event-log.ts", "security-events.ts"]) {
    const source = readFileSync(join(REPO_ROOT, "src/modules/identity", file), "utf8");
    assert.ok(!/\.(update|delete)\(/.test(source), `${file} must not update or delete`);
  }
});
test("deactivating a member ends their sessions and is recorded; reactivation changes no credential", async () => {
  const member = await newMember("COACH", "green", "deactivate");
  const keep = await newMember("COACH", "green", "deactivate");
  const victim = await signIn(app, member.email);
  const other = await signIn(app, member.email);
  const bystander = await signIn(app, keep.email);
  assert.equal((await victim.get("/api/academy/identity")).status, 200);
  const owner = await ownerClient();
  const save = (active: boolean, role = "COACH") =>
    owner.post("/api/academy/settings/member", { id: member.id, name: `Fixture ${member.id}`, email: member.email, role, active, professionalAttestation: "" });
  const off = await save(false);
  assert.equal(off.status, 200, off.text);
  assert.equal((await database().select().from(t.session).where(eq(t.session.userId, member.id))).length, 0, "every session is gone");
  assert.equal((await victim.get("/api/academy/identity")).status, 401);
  assert.equal((await other.get("/api/academy/identity")).status, 401);
  assert.equal((await bystander.get("/api/academy/identity")).status, 200, "other people keep theirs");
  // Signing back in as an inactive member yields no application access.
  const retry = app.anonymous();
  assert.equal((await retry.signIn(member.email, FIXTURE_PASSWORD)).status, 200);
  assert.equal((await retry.get("/api/academy/identity")).status, 403);
  // Reactivation and a role change; the password is untouched.
  assert.equal((await save(true, "FINANCE")).status, 200);
  const back = await signIn(app, member.email);
  assert.equal((await back.get("/api/academy/identity")).status, 200);
  const log = page(await owner.get(`${PATH}?person=${member.id}&limit=100`)).events;
  const by = (name: string) => log.filter((e) => e.event === name);
  assert.equal(by("MEMBER_DEACTIVATED").length, 1);
  assert.equal(by("MEMBER_DEACTIVATED")[0].detail.revokedSessions, 2);
  assert.equal(by("MEMBER_DEACTIVATED")[0].actor?.id, USERS.owner.id);
  assert.equal(by("MEMBER_REACTIVATED").length, 1);
  assert.deepEqual([by("MEMBER_ROLE_CHANGED")[0].detail.fromRole, by("MEMBER_ROLE_CHANGED")[0].detail.toRole], ["COACH", "FINANCE"]);
  // Saving with no change records nothing new.
  const total = log.length;
  assert.equal((await save(true, "FINANCE")).status, 200);
  assert.equal(page(await owner.get(`${PATH}?person=${member.id}&limit=100`)).events.length, total);
});
test("every event name has a label and outcome, and the view uses the same vocabulary as the writer", () => {
  const source = readFileSync(join(REPO_ROOT, "src/modules/identity/security-events.ts"), "utf8");
  const declared = [...source.matchAll(/\| "([A-Z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...SECURITY_EVENT_NAMES].sort(), declared);
  for (const name of SECURITY_EVENT_NAMES) {
    assert.ok(SECURITY_EVENT_META[name].label.length > 3, name);
    assert.ok(["success", "failed", "denied", "locked", "refused"].includes(SECURITY_EVENT_META[name].outcome));
  }
});
