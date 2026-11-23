import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import { provisionTestDatabase, type TestDatabase } from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile, unit } from "../src/modules/academy/application/access";
import { linkGuardian } from "../src/modules/players/application/service";
import {
  clearSuppression,
  contactsOverview,
  myWhatsAppOptIn,
  recordWhatsAppOptIn,
  revokeWhatsAppOptIn,
  saveContact,
  saveMyWhatsAppOptIn,
  suppressAddress,
} from "../src/modules/contacts/application/service";
import { addressKey, emailAllowed, normalizeEmail, normalizeWhatsApp, whatsAppAllowed } from "../src/modules/contacts/domain/contact-rules";

process.env.BETTER_AUTH_SECRET = "isolated-contacts-test-secret-1234567890123456";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
/**
 * Contacts: where a message may go. Player and parent e-mail and phone are independent values that may be equal or different;
 * the four combinations all work, nothing merges people by an address, WhatsApp opt-in is a small channel-specific record, and
 * suppression applies to the people a message was for and to nobody else who merely holds the same value.
 */
let testDb: TestDatabase | undefined;
const actor = (id: string, role: string, academyId = "green"): Actor => ({
  id,
  name: `Test ${id}`,
  role,
  academyId,
  timezone: "Asia/Kolkata",
  academyName: `Academy ${academyId}`,
});
const owner = actor("owner", "OWNER"),
  coach = actor("coach", "COACH"),
  blueOwner = actor("blue-owner", "OWNER", "blue");
/** Four families, one per combination of shared / different phone and e-mail. */
const FAMILIES = [
  { key: "same-same", playerEmail: "family1@example.test", playerPhone: "+919800000001", parentEmail: "family1@example.test", parentPhone: "+919800000001", sharedEmail: true, sharedPhone: true },
  { key: "same-phone", playerEmail: "kid2@example.test", playerPhone: "+919800000002", parentEmail: "parent2@example.test", parentPhone: "+919800000002", sharedEmail: false, sharedPhone: true },
  { key: "same-email", playerEmail: "family3@example.test", playerPhone: "+919800000031", parentEmail: "family3@example.test", parentPhone: "+919800000032", sharedEmail: true, sharedPhone: false },
  { key: "different", playerEmail: "kid4@example.test", playerPhone: "+919800000041", parentEmail: "parent4@example.test", parentPhone: "+919800000042", sharedEmail: false, sharedPhone: false },
] as const;
const parentId = (key: string) => `parent-${key}`;
const playerId = (key: string) => `player-${key}`;

before(async () => {
  testDb = await provisionTestDatabase("contacts");
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
  await db.insert(t.batches).values({ id: "blue-batch", academyId: "blue", coachId: "blue-owner", branchId: "blue-branch", name: "Blue" });
  await db.insert(t.players).values({ id: "blue-player", academyId: "blue", batchId: "blue-batch", name: "Blue Player" });
  await db.insert(t.profiles).values({ academyId: "blue", playerId: "blue-player", data: defaultProfile });
  for (const f of FAMILIES) {
    await db.insert(t.players).values({ id: playerId(f.key), academyId: "green", batchId: "green-batch", name: `Player ${f.key}` });
    await db.insert(t.profiles).values({
      academyId: "green",
      playerId: playerId(f.key),
      data: { ...defaultProfile, email: f.playerEmail, phone: f.playerPhone },
    });
    await db.insert(t.user).values({ id: parentId(f.key), name: `Parent ${f.key}`, email: f.parentEmail === f.playerEmail ? `login-${f.key}@example.test` : f.parentEmail, phone: f.parentPhone });
    await db.insert(t.memberships).values({ academyId: "green", userId: parentId(f.key), role: "GUARDIAN" });
    await linkGuardian(owner, { playerId: playerId(f.key), userId: parentId(f.key), relationship: "Parent", active: true });
  }
});
after(async () => {
  await testDb?.cleanup();
});
const refusedWith = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { status?: number; code?: string; message?: string });

test("the pure rules: addresses are normalised and compared as keys only; WhatsApp needs a live opt-in, e-mail only lacks a suppression", () => {
  assert.equal(normalizeEmail("  Parent@Example.TEST "), "parent@example.test");
  assert.equal(normalizeEmail("not an address"), null);
  assert.equal(normalizeWhatsApp("98765 43210", "IN"), "+919876543210");
  assert.equal(normalizeWhatsApp("98765 43210", "XX"), null, "no country code to read it in");
  assert.equal(normalizeWhatsApp("+1 415 555 0100", "IN"), "+14155550100");
  assert.equal(addressKey("EMAIL", "a@example.test", "s"), addressKey("EMAIL", "a@example.test", "s"));
  assert.notEqual(addressKey("EMAIL", "a@example.test", "s"), addressKey("WHATSAPP", "a@example.test", "s"), "the channel is part of the key");
  assert.ok(!addressKey("EMAIL", "a@example.test", "s").includes("example"), "the key never carries the address");
  const live = { channel: "WHATSAPP" as const, optedInAt: new Date(), optInRevokedAt: null, suppressedAt: null };
  assert.equal(whatsAppAllowed(live), true);
  assert.equal(whatsAppAllowed(undefined), false, "no record, no WhatsApp");
  assert.equal(whatsAppAllowed({ ...live, optInRevokedAt: new Date() }), false, "revoked");
  assert.equal(whatsAppAllowed({ ...live, suppressedAt: new Date() }), false, "suppressed");
  assert.equal(whatsAppAllowed({ ...live, optedInAt: null }), false, "never opted in");
  assert.equal(emailAllowed(undefined), true, "e-mail needs no record");
  assert.equal(emailAllowed({ channel: "EMAIL", optedInAt: null, optInRevokedAt: null, suppressedAt: new Date() }), false);
});

test("all four combinations of shared and different phone and e-mail are stored and shown independently; nobody is merged", async () => {
  for (const f of FAMILIES) {
    const view = await contactsOverview(owner, { playerId: playerId(f.key) });
    const player = view.player.contacts;
    assert.equal(player.find((c) => c.channel === "EMAIL")?.address, f.playerEmail, `${f.key}: the player's own e-mail`);
    assert.equal(player.find((c) => c.channel === "WHATSAPP")?.address, f.playerPhone, `${f.key}: the player's own number`);
    assert.equal(view.parents.length, 1);
    const parent = view.parents[0];
    assert.equal(parent.userId, parentId(f.key), `${f.key}: the parent stays their own account`);
    const phone = parent.contacts.find((c) => c.channel === "WHATSAPP")?.address;
    assert.equal(phone, f.parentPhone);
    assert.equal(phone === player.find((c) => c.channel === "WHATSAPP")?.address, f.sharedPhone, `${f.key}: the phone is shared exactly when it is the same`);
    const mail = parent.contacts.find((c) => c.channel === "EMAIL")?.address;
    assert.ok(mail);
    assert.equal(f.sharedEmail ? mail !== f.playerEmail : mail !== f.playerEmail, true, "the login e-mail of the parent account is the account's own");
  }
  // Sharing a value never changed any account or link: still one account and one link per family.
  assert.equal((await database().select().from(t.guardianLinks).where(eq(t.guardianLinks.academyId, "green"))).length, 4);
});

test("an extra contact may equal another person's value; invalid values, strangers, other academies and the wrong role are refused", async () => {
  const key = "different";
  const shared = "+919800000042"; // the parent's own number, saved ALSO as an extra number for the player
  const first = await saveContact(owner, { playerId: playerId(key), channel: "WHATSAPP", address: "98000 00042", label: "Parent's phone" });
  assert.equal(first.created, true);
  assert.equal((await saveContact(owner, { playerId: playerId(key), channel: "WHATSAPP", address: shared })).created, false, "the same value twice for the same person is one contact");
  const forParent = await saveContact(owner, { playerId: playerId(key), userId: parentId(key), channel: "WHATSAPP", address: "+919800000099", label: "Work" });
  assert.equal(forParent.created, true);
  const rows = await database().select().from(t.contactPoints).where(eq(t.contactPoints.address, shared));
  assert.equal(rows.length, 1, "stored once for the player; the parent's own number lives on the account");
  assert.ok(await refusedWith(saveContact(owner, { playerId: playerId(key), channel: "WHATSAPP", address: "12" })), "too short to be a number");
  assert.equal((await refusedWith(saveContact(owner, { playerId: playerId(key), channel: "WHATSAPP", address: "12345" })))?.status, 422, "not a usable international number");
  assert.equal((await refusedWith(saveContact(owner, { playerId: playerId(key), channel: "EMAIL", address: "nope" })))?.status, 422);
  assert.equal((await refusedWith(saveContact(owner, { playerId: playerId("same-same"), userId: parentId("different"), channel: "EMAIL", address: "x@example.test" })))?.status, 404, "that parent is not linked to this player");
  assert.equal((await refusedWith(saveContact(blueOwner, { playerId: playerId(key), channel: "EMAIL", address: "x@example.test" })))?.status, 404, "another academy cannot reach this player");
  assert.ok((await refusedWith(saveContact(coach, { playerId: playerId(key), channel: "EMAIL", address: "x@example.test" }))), "a coach may not edit contacts");
  const view = await contactsOverview(owner, { playerId: playerId(key) });
  assert.ok(view.player.contacts.some((c) => c.origin === "EXTRA" && c.address === shared));
  assert.ok(view.parents[0].contacts.some((c) => c.origin === "EXTRA" && c.address === "+919800000099"));
});

test("WhatsApp opt-in is a small record with its source, time and revocation; it is per number and gates nothing else", async () => {
  const key = "same-phone";
  let view = await contactsOverview(owner, { playerId: playerId(key) });
  assert.equal(view.parents[0].contacts.find((c) => c.channel === "WHATSAPP")?.optedIn, false, "nothing is opted in by default");
  assert.equal(view.parents[0].contacts.find((c) => c.channel === "EMAIL")?.optedIn, null, "e-mail has no opt-in at all");
  const rec = await recordWhatsAppOptIn(owner, { playerId: playerId(key), userId: parentId(key), source: "OWNER_WRITTEN" });
  assert.equal(rec.optedIn, true);
  view = await contactsOverview(owner, { playerId: playerId(key) });
  const parentNumber = view.parents[0].contacts.find((c) => c.channel === "WHATSAPP")!;
  assert.deepEqual([parentNumber.optedIn, parentNumber.optInSource], [true, "OWNER_WRITTEN"]);
  assert.ok(parentNumber.optedInAt);
  // the player's own number is the SAME value but a different subject: it is not opted in by the parent's record
  assert.equal(view.player.contacts.find((c) => c.channel === "WHATSAPP")?.optedIn, false, "no merging by equal numbers");
  // an unknown source (including the one only the accept step writes) is refused
  assert.ok(await refusedWith(recordWhatsAppOptIn(owner, { playerId: playerId(key), userId: parentId(key), source: "INVITATION_ACCEPT" })));
  assert.ok(await refusedWith(recordWhatsAppOptIn(coach, { playerId: playerId(key), userId: parentId(key), source: "OWNER_VERBAL" })), "a coach cannot record it");
  assert.equal((await refusedWith(recordWhatsAppOptIn(blueOwner, { playerId: playerId(key), userId: parentId(key), source: "OWNER_VERBAL" })))?.status, 404);
  // revoke: the record stays and says when
  await revokeWhatsAppOptIn(owner, { playerId: playerId(key), userId: parentId(key) });
  const [row] = await database().select().from(t.contactPoints).where(and(eq(t.contactPoints.userId, parentId(key)), eq(t.contactPoints.channel, "WHATSAPP")));
  assert.ok(row.optedInAt && row.optInRevokedAt, "the opt-in and its revocation are both kept");
  view = await contactsOverview(owner, { playerId: playerId(key) });
  assert.equal(view.parents[0].contacts.find((c) => c.channel === "WHATSAPP")?.optedIn, false);
  assert.equal((await refusedWith(revokeWhatsAppOptIn(owner, { playerId: playerId("different"), userId: parentId("different"), address: "+919800000077" })))?.status, 404, "nothing to revoke");
  // audit: the action is recorded with a masked number, never the number itself
  const audits = await database().select().from(t.audit).where(eq(t.audit.action, "contact-optin"));
  assert.ok(audits.length >= 1);
  assert.ok(!JSON.stringify(audits).includes("919800000002"), "no full number in the audit trail");
});

test("a parent controls their own WhatsApp opt-in from their account", async () => {
  const mine = actor(parentId("same-email"), "GUARDIAN");
  assert.deepEqual(await myWhatsAppOptIn(mine), { hasNumber: true, optedIn: false });
  assert.deepEqual(await saveMyWhatsAppOptIn(mine, { optIn: true }), { optedIn: true });
  assert.deepEqual(await myWhatsAppOptIn(mine), { hasNumber: true, optedIn: true });
  const [row] = await database().select().from(t.contactPoints).where(and(eq(t.contactPoints.userId, mine.id), eq(t.contactPoints.channel, "WHATSAPP")));
  assert.equal(row.optInSource, "PARENT_FORM");
  assert.deepEqual(await saveMyWhatsAppOptIn(mine, { optIn: false }), { optedIn: false });
  assert.deepEqual(await myWhatsAppOptIn(mine), { hasNumber: true, optedIn: false });
  await database().update(t.user).set({ phone: null }).where(eq(t.user.id, parentId("same-same")));
  assert.equal((await refusedWith(saveMyWhatsAppOptIn(actor(parentId("same-same"), "GUARDIAN"), { optIn: true })))?.code, "NO_NUMBER");
});

test("suppression applies to the people a message was for and to nobody else who holds the same value; an owner can clear it", async () => {
  const db = database();
  // the parent of 'same-email' and the player share a value only by coincidence of data; suppress it for the PARENT's account only
  const address = "family3@example.test";
  await unit(owner, (tx) => suppressAddress(tx, "green", "EMAIL", address, [{ kind: "ACCOUNT", id: parentId("same-email") }], "BOUNCED"));
  const parentRows = await db.select().from(t.contactPoints).where(and(eq(t.contactPoints.userId, parentId("same-email")), eq(t.contactPoints.address, address)));
  assert.equal(parentRows.length, 1);
  assert.equal(parentRows[0].suppressionReason, "BOUNCED");
  const playerRows = await db.select().from(t.contactPoints).where(and(eq(t.contactPoints.playerId, playerId("same-email")), eq(t.contactPoints.address, address)));
  assert.equal(playerRows.length, 0, "the player holding the same value is not suppressed");
  const view = await contactsOverview(owner, { playerId: playerId("same-email") });
  assert.equal(view.player.contacts.find((c) => c.channel === "EMAIL")?.suppressed, false);
  // a "stop" on WhatsApp also withdraws the opt-in
  await recordWhatsAppOptIn(owner, { playerId: playerId("different"), userId: parentId("different"), source: "PARENT_FORM" });
  await unit(owner, (tx) => suppressAddress(tx, "green", "WHATSAPP", "+919800000042", [{ kind: "ACCOUNT", id: parentId("different") }], "STOP"));
  const after = await contactsOverview(owner, { playerId: playerId("different") });
  const number = after.parents[0].contacts.find((c) => c.channel === "WHATSAPP" && c.address === "+919800000042")!;
  assert.deepEqual([number.suppressed, number.optedIn, number.suppressionReason], [true, false, "STOP"]);
  assert.ok(number.id);
  await clearSuppression(owner, { id: number.id });
  assert.ok(await refusedWith(clearSuppression(coach, { id: number.id })), "a coach cannot clear it");
  const [cleared] = await db.select().from(t.contactPoints).where(eq(t.contactPoints.id, number.id));
  assert.equal(cleared.suppressedAt, null);
  assert.equal(cleared.optInRevokedAt !== null, true, "clearing a suppression does not silently restore the opt-in");
});
