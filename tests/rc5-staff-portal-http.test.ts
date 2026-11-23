import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import type { Actor } from "../src/modules/identity/access";
import { DomainError } from "../src/modules/training/domain/rules";
import { ROLES, ROLE_USER, idsFor, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { newMember, signedIn } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";
/**
 * RC-5 staff portal authorization over real HTTP (real route handlers, real Better Auth sessions, disposable DB).
 * Every expectation below is written out by hand per stored role; none is computed with can().
 *
 *   reads    the staff read model, Training Studio, and every sensitive export/log/report endpoint, per role;
 *   writes   staff-only mutations refused to each designation that does not hold the capability, with forged
 *            role / designation / account-type fields in the body, the query and headers, and nothing changes;
 *   change   a membership re-roled between requests is judged by its new stored role on the very next request;
 *   direct   the staff read model refuses a forged actor whose role is not a staff role (fail closed).
 */
let app: Harness;
before(async () => (app = await startHarness("rc5-staff-portal")), { timeout: HOOK_TIMEOUT });
after(async () => app.stop(), { timeout: HOOK_TIMEOUT });

const API = "/api/academy";
const A = idsFor("childA"); // green-main batch, coached by the fixture COACH; guardian-one is the billing contact
const DENIED = "Your role cannot perform this action.";
const client = (role: Role) => app.as(ROLE_USER[role]);
const errorOf = (r: { json: unknown }) => (r.json as { error?: string } | null)?.error;

/** "Y" = 200, "-" = refused (403), "." = not part of this check (another portal / covered by family suites). */
// Columns: OWNER ADMIN HEAD_COACH COACH FINANCE NUTRITION_PRO GUARDIAN ADULT_PLAYER
const READS: [string, string][] = [
  ["/api/training", "Y Y Y Y - - - -"],
  [`${API}/consent/report`, "Y Y - - - - - -"], // D9-a: Head Coach has no consent report
  [`${API}/access-events`, "Y Y - - - - - -"],
  [`${API}/security-events`, "Y Y - - - - - -"],
  [`${API}/privacy/overview`, "Y Y - - - - - -"],
  [`${API}/reports/${A.reportId}/pdf`, "Y Y Y Y - - . ."],
  [`${API}/fees/${A.paymentId}/receipt`, "Y Y - - Y - . ."],
  [`${API}/media/${A.media.shared}/link`, "Y Y Y Y - - . ."],
];

test("staff read model: every staff role gets the staff payload with its own permissions; families get theirs", async () => {
  const expected: Record<Role, { family: boolean; ops: boolean; finance: boolean; coaching: boolean; professional: boolean; owner: boolean }> = {
    OWNER: { family: false, ops: true, finance: true, coaching: true, professional: false, owner: true },
    ADMIN: { family: false, ops: true, finance: true, coaching: true, professional: false, owner: false },
    HEAD_COACH: { family: false, ops: true, finance: false, coaching: true, professional: false, owner: false },
    COACH: { family: false, ops: false, finance: false, coaching: true, professional: false, owner: false },
    FINANCE: { family: false, ops: false, finance: true, coaching: false, professional: false, owner: false },
    NUTRITION_PRO: { family: false, ops: false, finance: false, coaching: false, professional: true, owner: false },
    GUARDIAN: { family: true, ops: false, finance: false, coaching: false, professional: false, owner: false },
    ADULT_PLAYER: { family: true, ops: false, finance: false, coaching: false, professional: false, owner: false },
  };
  for (const role of ROLES) {
    const c = await client(role);
    // A forged role in the query or headers changes nothing.
    const r = await c.get(`${API}?role=OWNER&designation=ADMINISTRATOR`, { headers: { "x-role": "OWNER", "x-designation": "ADMINISTRATOR" } });
    assert.equal(r.status, 200, `${role}: ${r.status} ${r.text.slice(0, 120)}`);
    const body = r.json as { actor: { role: string }; permissions: Record<string, boolean>; members: unknown[] };
    assert.equal(body.actor.role, role);
    assert.deepEqual(body.permissions, expected[role], role);
  }
});

test("sensitive reads, exports and alternate endpoints follow each designation's capabilities", async () => {
  const refusalStatus: Record<string, number> = {};
  for (const [path, row] of READS) {
    const cells = row.split(" ");
    assert.equal(cells.length, ROLES.length, path);
    for (const [i, role] of ROLES.entries()) {
      if (cells[i] === ".") continue;
      const r = await (await client(role)).get(path);
      if (cells[i] === "Y") assert.equal(r.status, 200, `${role} ${path}: ${r.status} ${r.text.slice(0, 160)}`);
      else {
        // Refused: 403, or 404 where the record-scope check comes first and does not reveal the record exists
        // (e.g. reportAccess: a FINANCE account has no players, so the report's player is "not found").
        assert.ok([403, 404].includes(r.status), `${role} ${path}: ${r.status} ${r.text.slice(0, 160)}`);
        refusalStatus[`${role} ${path.replace(/[^/]+\/(pdf|receipt|link)$/, ":id/$1")}`] = r.status;
        assert.ok(!/CANARY/i.test(r.text), `${role} ${path}: no record content in a refusal`);
      }
    }
  }
  // Evidence for the report: which refusals are 404 rather than 403.
  console.log("RC5_REFUSALS_404", JSON.stringify(Object.entries(refusalStatus).filter(([, s]) => s === 404).map(([k]) => k)));
});

/** Staff-only mutations and the stored roles allowed past the capability check (written out by hand). */
const WRITES: { route: string; capability: string; allowed: Role[] }[] = [
  { route: "settings/save", capability: "academy.settings", allowed: ["OWNER", "ADMIN"] },
  { route: "settings/branch", capability: "academy.structure", allowed: ["OWNER", "ADMIN", "HEAD_COACH"] },
  { route: "admissions/save", capability: "admissions.manage", allowed: ["OWNER", "ADMIN", "HEAD_COACH"] },
  { route: "players/save", capability: "players.manage", allowed: ["OWNER", "ADMIN", "HEAD_COACH"] },
  { route: "calendar/event", capability: "calendar.manage", allowed: ["OWNER", "ADMIN", "HEAD_COACH"] },
  { route: "fees/plan", capability: "finance.manage", allowed: ["OWNER", "ADMIN", "FINANCE"] },
  { route: "fees/void", capability: "finance.manage", allowed: ["OWNER", "ADMIN", "FINANCE"] },
  { route: "nutrition/assign", capability: "nutrition.assign", allowed: ["OWNER", "ADMIN"] },
  { route: "communications/template", capability: "comms.approve", allowed: ["OWNER", "ADMIN", "HEAD_COACH"] },
  { route: "privacy/request", capability: "privacy.manage", allowed: ["OWNER", "ADMIN"] },
  { route: "consent/version", capability: "consent.admin", allowed: ["OWNER", "ADMIN"] },
];
const STAFF: Role[] = ["ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"];
const FORGED = { role: "OWNER", accountType: "OWNER", designation: "ADMINISTRATOR", capabilities: ["academy.settings"], academyId: "blue" };

async function fingerprint() {
  const db = database();
  const [settings, branches, enquiries, players, events, plans, invoices, assignments, templates, requests, versions] = await Promise.all([
    db.select().from(t.academySettings),
    db.select().from(t.branches),
    db.select().from(t.enquiries),
    db.select().from(t.players),
    db.select().from(t.calendarEvents),
    db.select().from(t.feePlans),
    db.select().from(t.invoices),
    db.select().from(t.nutritionAssignments),
    db.select().from(t.messageTemplates),
    db.select().from(t.erasureRequests),
    db.select().from(t.consentPolicyVersions),
  ]);
  return JSON.stringify({ settings, branches, enquiries, players, events, plans, invoices, assignments, templates, requests, versions });
}

test("staff-only mutations: each designation without the capability is refused, forged fields ignored, nothing changes", async () => {
  const before = await fingerprint();
  let refusals = 0;
  for (const w of WRITES)
    for (const role of [...STAFF, "GUARDIAN", "ADULT_PLAYER"] as Role[]) {
      if (w.allowed.includes(role)) continue;
      const c: TestClient = await client(role);
      const r = await c.post(`${API}/${w.route}?role=OWNER`, { ...FORGED }, { headers: { "x-role": "OWNER" } });
      assert.equal(r.status, 403, `${role} ${w.route}: ${r.status} ${r.text.slice(0, 160)}`);
      assert.equal(errorOf(r), DENIED, `${role} ${w.route}`);
      refusals++;
    }
  assert.ok(refusals >= 50, `refusals checked: ${refusals}`);
  assert.equal(await fingerprint(), before, "no refused request changed any record");
});

test("a membership re-roled between requests is judged by its new stored role on the next request", async () => {
  const m = await newMember("HEAD_COACH", "green", "rc5-rerole");
  const c = await signedIn(app, m.email);
  const first = await c.get(API);
  assert.equal(first.status, 200);
  assert.equal((first.json as { permissions: { ops: boolean } }).permissions.ops, true);
  // The owner demotes the account to COACH (direct DB change stands in for the owner's saveMember).
  await database().update(t.memberships).set({ role: "COACH" }).where(and(eq(t.memberships.userId, m.id), eq(t.memberships.academyId, "green")));
  const after = await c.get(API);
  assert.equal(after.status, 200);
  assert.deepEqual((after.json as { actor: { role: string } }).actor.role, "COACH");
  assert.equal((after.json as { permissions: { ops: boolean } }).permissions.ops, false);
  const refused = await c.post(`${API}/admissions/save`, { name: "rc5 enquiry" });
  assert.equal(refused.status, 403, refused.text.slice(0, 160));
  // Demoted to a family account: the staff read model is no longer served.
  await database().update(t.memberships).set({ role: "GUARDIAN" }).where(and(eq(t.memberships.userId, m.id), eq(t.memberships.academyId, "green")));
  const familyView = await c.get(API);
  assert.equal(familyView.status, 200);
  assert.equal((familyView.json as { permissions: { family: boolean } }).permissions.family, true);
  assert.equal((await c.get("/api/training")).status, 403);
});

test("direct: the staff read model refuses a forged actor that is not a staff role (fail closed)", async () => {
  for (const role of ["SUPER_ADMIN", "STAFF", "ADMINISTRATOR", "owner", "", "constructor", "__proto__"]) {
    const forged: Actor = { id: "rc5-forged", name: "Forged", academyId: "green", role, timezone: "Asia/Kolkata", academyName: "x" };
    await assert.rejects(
      () => bootstrapAcademy(forged),
      (e: unknown) => e instanceof DomainError && e.status === 403 && e.message === DENIED,
      JSON.stringify(role),
    );
  }
});
