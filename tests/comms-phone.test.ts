import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";

/**
 * The registered WhatsApp number (app_user.phone): who may set it, validation to E.164, the database CHECK, one number per
 * ACCOUNT (not per guardian link), what is audited, and that it touches no authentication. No OTP: the number is unverified.
 */
let app: Harness;
const db = () => database();
const route = "/api/academy/communications/phone";
const phoneOf = async (userId: string) => (await db().select({ p: t.user.phone }).from(t.user).where(eq(t.user.id, userId)))[0]?.p ?? null;
const keyed = (who: Parameters<Harness["as"]>[0]) => app.as(who);

before(async () => { app = await startHarness("comms-phone"); delete process.env.WHATSAPP_DEFAULT_COUNTRY_CODE; }, { timeout: HOOK_TIMEOUT });
after(async () => { delete process.env.WHATSAPP_DEFAULT_COUNTRY_CODE; await app.stop(); }, { timeout: HOOK_TIMEOUT });

test("a member registers their own number; it is stored in E.164 and replaced or cleared by them", { timeout: TEST_TIMEOUT }, async () => {
  const g = await keyed("guardian");
  const r = await g.post(route, { phone: "+91 98765-43210" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { registered: true, last4: "3210" });
  assert.equal(await phoneOf(USERS.guardian.id), "+919876543210");
  assert.equal((await g.post(route, { phone: "0044 7700 900123" })).status, 200);
  assert.equal(await phoneOf(USERS.guardian.id), "+447700900123", "00 prefix is accepted and stored with +");
  assert.equal((await g.post(route, { phone: "" })).status, 200);
  assert.equal(await phoneOf(USERS.guardian.id), null, "an empty value clears it");
  assert.equal((await g.post(route, { phone: "+91 98765 43210" })).status, 200);
  assert.equal((await g.post(route, { phone: null })).status, 200);
  assert.equal(await phoneOf(USERS.guardian.id), null);
});

test("invalid numbers are refused (422) and change nothing; a national number is read in the academy's country", { timeout: TEST_TIMEOUT }, async () => {
  const g = await keyed("guardian");
  await g.post(route, { phone: "+91 98765 43210" });
  for (const bad of ["abc", "+12", "+91 98765 4321012345678", "call me", "+91 98765 43210 ext 5", "++919876543210", "+0 1234567890"]) {
    const r = await g.post(route, { phone: bad });
    assert.equal(r.status, 422, `${bad}: ${r.status}`);
    assert.match(r.text, /country code/);
    assert.equal(await phoneOf(USERS.guardian.id), "+919876543210", `${bad} changed nothing`);
  }
  // No country code typed: the academy is in India, so the number is read as +91.
  assert.equal((await g.post(route, { phone: "098765 43211" })).status, 200);
  assert.equal(await phoneOf(USERS.guardian.id), "+919876543211");
});

test("only an owner may set someone else's number, and only for a member of the same academy", { timeout: TEST_TIMEOUT }, async () => {
  const target = USERS.guardian2.id;
  await (await keyed("guardian2")).post(route, { phone: null });
  for (const who of ["guardian", "coach", "finance", "headCoach", "nutrition"] as const) {
    const r = await (await keyed(who)).post(route, { userId: target, phone: "+91 90000 00001" });
    assert.ok([401, 403].includes(r.status), `${who}: ${r.status}`);
  }
  const admin = await (await keyed("admin")).post(route, { userId: target, phone: "+91 90000 00001" });
  assert.equal(admin.status, 403, "an Administrator is not an owner: members.manage is owner-only");
  assert.equal(await phoneOf(target), null, "none of the refused calls changed anything");

  const owner = await (await keyed("owner")).post(route, { userId: target, phone: "+91 90000 00002" });
  assert.equal(owner.status, 200, owner.text);
  assert.equal(await phoneOf(target), "+919000000002");

  const other = await (await keyed("owner")).post(route, { userId: USERS.blueGuardian.id, phone: "+91 90000 00003" });
  assert.equal(other.status, 404, "an owner cannot reach an account of another academy");
  assert.equal(await phoneOf(USERS.blueGuardian.id), null);
  const missing = await (await keyed("owner")).post(route, { userId: "no-such-user", phone: "+91 90000 00003" });
  assert.equal(missing.status, 404);
  assert.equal((await (await app.anonymous()).post(route, { phone: "+91 90000 00004" })).status, 401);
});

test("the audit record keeps only the last four digits; the number is not exposed to other people's payloads", { timeout: TEST_TIMEOUT }, async () => {
  await (await keyed("guardian")).post(route, { phone: "+91 98765 43210" });
  await (await keyed("guardian2")).post(route, { phone: "+91 97000 11111" });
  const revisions = await db().select().from(t.recordRevisions).where(and(eq(t.recordRevisions.kind, "user-phone"), eq(t.recordRevisions.entityId, USERS.guardian.id)));
  assert.ok(revisions.length >= 1);
  const all = JSON.stringify(revisions);
  assert.equal(all.includes("9876543210") || all.includes("919876"), false, "no full number in the revision history");
  assert.ok(revisions.some((r) => (r.data as { last4: string | null }).last4 === "3210"));
  const audits = await db().select().from(t.audit).where(and(eq(t.audit.action, "user-phone"), eq(t.audit.entityId, USERS.guardian.id)));
  assert.ok(audits.length >= 1);
  assert.equal(JSON.stringify(audits).includes("9876543210"), false);
  // Another family's payload never contains this guardian's number.
  const payload = await (await keyed("guardian2")).get("/api/academy");
  assert.equal(payload.status, 200);
  assert.equal(payload.text.includes("9876543210"), false);
  const staff = await (await keyed("coach")).get("/api/academy");
  assert.equal(staff.text.includes("9876543210"), false, "the number is not part of the workspace payload");
});

test("database: only E.164 or NULL can be stored; one number per account, nothing on guardian links or players", { timeout: TEST_TIMEOUT }, async () => {
  const id = USERS.guardian.id;
  const set = (phone: string | null) => db().execute(sql`update app_user set phone = ${phone} where id = ${id}`);
  for (const bad of ["98765 43210", "+91 98765 43210", "919876543210", "+12", "+0123456789", "+9198765432101234", "abc", ""])
    await assert.rejects(() => set(bad), /./, `${JSON.stringify(bad)} must be rejected by app_user_phone_e164_check`);
  await set("+919876543210");
  assert.equal(await phoneOf(id), "+919876543210");
  await set(null);
  assert.equal(await phoneOf(id), null);
  const cols = await db().execute(sql`select table_name, column_name from information_schema.columns where table_schema = 'public' and column_name ilike '%phone%' order by 1, 2`);
  const rows = (cols as unknown as { rows?: { table_name: string; column_name: string }[] }).rows ?? (cols as unknown as { table_name: string; column_name: string }[]);
  assert.deepEqual(rows.map((r) => `${r.table_name}.${r.column_name}`), ["app_user.phone"], "a phone column exists only on the account: none on guardian_link, player or membership");
});

test("registering a number changes nothing about sign-in: it is not a factor and not an identifier", { timeout: TEST_TIMEOUT }, async () => {
  const g = await keyed("guardian");
  await g.post(route, { phone: "+91 98765 43210" });
  const session = await g.get("/api/auth/get-session");
  assert.equal(session.status, 200);
  assert.equal(session.text.includes("9876543210"), false, "the session does not carry the number");
  assert.equal((await g.get("/api/academy")).status, 200);
  const anon = await app.anonymous();
  const attempt = await anon.post("/api/auth/sign-in/email", { email: "+919876543210", password: "irrelevant" });
  assert.ok(attempt.status >= 400, "a phone number cannot be used to sign in");
});
