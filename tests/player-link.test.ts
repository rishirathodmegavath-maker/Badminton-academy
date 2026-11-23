import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { config } from "../src/shared/config";
import { TERMS_VERSION } from "../src/modules/identity/onboarding-policy";
import { hashInvitationToken } from "../src/modules/invitations/token";
import { parsePlayerLinkAddress, playerLinkAddress } from "../src/modules/invitations/player-link";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { NEW_PASSWORD, signedIn, unique } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";

/**
 * "Add player" by invitation link: staff make a link for a batch; whoever opens it first signs in with ANY email and becomes
 * the player's own login, then fills in their own details. Real HTTP over the real route handlers and Better Auth endpoints.
 * What must hold: one use only, expiry and withdrawal, the player sees only their own record and only the schedule, reports
 * and media of it, nothing in the link grants anything by itself, and the wrong kinds of account are refused.
 */
for (const name of ["EMAIL_PROVIDER", "RESEND_API_KEY", "ZEPTOMAIL_TOKEN", "ZEPTOMAIL_API_URL", "EMAIL_FROM"]) delete process.env[name];
let app: Harness;
before(async () => {
  app = await startHarness("player-link");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app?.stop();
}, { timeout: HOOK_TIMEOUT });

const API = "/api/academy";
const AUTH = "/api/auth";
const db = () => database();
const email = (tag = "pl") => `${tag}-${unique()}-${Date.now().toString(36)}@example.test`;
type Link = { id: string; link: string; kind: string; expiresAt: string };
const tokenOf = (link: string) => link.split("#")[1];
const makeLink = (c: TestClient, body: Record<string, unknown>) => c.post(`${API}/invitations/player-link`, body);
const mine = async (c: TestClient, body: Record<string, unknown> = { batchId: "blue-batch" }) => {
  const r = await makeLink(c, body);
  assert.equal(r.status, 200, r.text);
  return r.json as Link;
};
const accept = (c: TestClient, token: string) => c.post(`${AUTH}/invitations/accept`, { token });
const preview = (token: string) => app.anonymous().post(`${AUTH}/invitations/preview`, { token });
async function registered(address: string) {
  const password = NEW_PASSWORD();
  const r = await app.anonymous().post(`${AUTH}/onboarding/signup`, { name: "Joining Player", email: address, password, acceptTerms: true, termsVersion: TERMS_VERSION });
  assert.equal(r.status, 200, r.text);
  return { id: ((await db().select().from(t.user).where(eq(t.user.email, address)))[0]).id, client: await signedIn(app, address, password) };
}
const membership = async (userId: string) =>
  (await db().select().from(t.memberships).where(and(eq(t.memberships.userId, userId), eq(t.memberships.academyId, "blue"))))[0];
const under18 = () => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 12);
  return d.toISOString().slice(0, 10);
};
const details = { name: "Aarya Link", birthDate: under18(), email: "", phone: "+91 98765 43210", preferences: "Prefers evening sessions" };
/** A new person who opened a link, signed up with an address of their own choosing, and accepted it. */
async function joined(c: TestClient, body: Record<string, unknown> = { batchId: "blue-batch" }) {
  const link = await mine(c, body);
  const person = await registered(email("joiner"));
  const r = await accept(person.client, tokenOf(link.link));
  assert.equal(r.status, 200, r.text);
  return { link, ...person };
}

test("the address format carries the batch, round-trips, and is never a real address", () => {
  const nonce = "0123456789abcdef0123456789abcdef";
  const address = playerLinkAddress("blue-batch", nonce);
  assert.ok(address.endsWith("@links.invalid") && address === address.toLowerCase());
  assert.deepEqual(parsePlayerLinkAddress(address), { batchId: "blue-batch" });
  assert.deepEqual(parsePlayerLinkAddress(playerLinkAddress("Batch/ÄÖ 1", nonce)), { batchId: "Batch/ÄÖ 1" });
  for (const bad of ["a@b.test", "player-link.zz.0123456789abcdef0123456789abcdef@links.invalid", "player-link.abc.0123456789abcdef0123456789abcdef@links.invalid", "player-link.6162.short@links.invalid", ""])
    assert.equal(parsePlayerLinkAddress(bad), null, bad);
  assert.throws(() => playerLinkAddress("", nonce));
  assert.throws(() => playerLinkAddress("x".repeat(91), nonce));
  assert.ok(playerLinkAddress("x".repeat(90), nonce).length <= 254, "fits the table's address limit");
});

test("who may make a link: a person who may add players, for a batch of their own academy; nobody else", async () => {
  const blueOwner = await app.as("blueOwner");
  const link = await mine(blueOwner);
  assert.equal(link.kind, "PLAYER_LINK");
  assert.match(link.link, /\/invite#[A-Za-z0-9_-]+$/, "the secret is in the fragment, never in a path or query");
  // Stored as a hash, with a generated non-deliverable address; the token itself is nowhere in the database.
  const [row] = await db().select().from(t.academyInvitations).where(eq(t.academyInvitations.id, link.id));
  assert.equal(row.kind, "ADULT_PLAYER");
  assert.equal(row.role, "ADULT_PLAYER");
  assert.ok(row.inviteeEmail.endsWith("@links.invalid"));
  assert.equal(JSON.stringify(row).includes(tokenOf(link.link)), false);
  assert.ok(row.expiresAt.getTime() - row.createdAt.getTime() <= 3.01 * 86_400_000, "three days unless chosen otherwise");
  // A coach does not add players; another academy's batch is not theirs; the lifetime is capped.
  assert.equal((await makeLink(await app.as("coach"), { batchId: "green-main" })).status, 403);
  assert.ok([403, 404].includes((await makeLink(blueOwner, { batchId: "green-main" })).status), "another academy's batch");
  assert.equal((await makeLink(blueOwner, { batchId: "no-such-batch" })).status, 404);
  assert.equal((await makeLink(blueOwner, { batchId: "blue-batch", expiresInDays: 400 })).status, 422);
  assert.equal((await makeLink(app.anonymous(), { batchId: "blue-batch" })).status, 401);
  // The list shows it as a link, never the generated address.
  const listed = ((await blueOwner.get(`${API}/invitations`)).json as { invitations: { email: string; kind: string }[] }).invitations;
  assert.ok(listed.some((i) => i.email === "Player invitation link"));
  assert.ok(!JSON.stringify(listed).includes("links.invalid"));
});

test("the review screen offers a player login to whoever holds the link, naming no person and no address", async () => {
  const link = await mine(await app.as("blueOwner"));
  const p = await preview(tokenOf(link.link));
  assert.equal(p.status, 200);
  const body = p.json as { kind: string; role: string; emailHint: string; academyName: string };
  assert.equal(body.kind, "ADULT_PLAYER");
  assert.equal(body.emailHint, "Any email address");
  assert.ok(!p.text.includes("links.invalid"));
});

test("ANY email can accept; it works once; the first person gets a player login and nothing else", async () => {
  const blueOwner = await app.as("blueOwner");
  const link = await mine(blueOwner);
  const first = await registered(email("first"));
  const second = await registered(email("second"));
  assert.equal(await membership(first.id), undefined, "holding the link grants nothing until it is accepted");
  const r = await accept(first.client, tokenOf(link.link));
  assert.equal(r.status, 200, r.text);
  assert.equal((await membership(first.id))?.role, "ADULT_PLAYER");
  // One use: a second person is refused; the first person's repeat is harmless.
  const again = await accept(second.client, tokenOf(link.link));
  assert.equal(again.status, 409);
  assert.equal(await membership(second.id), undefined);
  assert.equal((await accept(first.client, tokenOf(link.link))).status, 200, "repeat by the same person is idempotent");
  const [row] = await db().select().from(t.academyInvitations).where(eq(t.academyInvitations.id, link.id));
  assert.equal(row.status, "ACCEPTED");
  assert.equal(row.acceptedByUserId, first.id);
  // No player record exists yet: opening the link created an account, not a player.
  const players = await db().select().from(t.players).where(and(eq(t.players.academyId, "blue")));
  assert.ok(!players.some((p) => p.name === details.name));
});

test("a withdrawn link, an expired link and a made-up link do nothing", async () => {
  const blueOwner = await app.as("blueOwner");
  const link = await mine(blueOwner);
  assert.equal((await blueOwner.post(`${API}/invitations/revoke`, { id: link.id })).status, 200);
  const person = await registered(email("late"));
  assert.equal((await accept(person.client, tokenOf(link.link))).status, 410);
  assert.equal(await membership(person.id), undefined);
  assert.equal((await accept(person.client, "x".repeat(43))).status, 404);
  // Expired: the database refuses to edit an expiry, so a link is planted that is already past it (as the invitation suite does).
  const token = `expired-${unique()}-`.padEnd(43, "x");
  await db()
    .insert(t.academyInvitations)
    .values({
      academyId: "blue",
      inviteeEmail: playerLinkAddress("blue-batch", "0123456789abcdef0123456789abcdef"),
      kind: "ADULT_PLAYER",
      role: "ADULT_PLAYER",
      invitedByUserId: "fx-blue-owner",
      tokenHash: hashInvitationToken(token, config().BETTER_AUTH_SECRET),
      createdAt: new Date(Date.now() - 10 * 86_400_000),
      expiresAt: new Date(Date.now() - 86_400_000),
    });
  const late2 = await registered(email("later"));
  assert.equal((await accept(late2.client, token)).status, 410, "an expired link is refused");
  assert.equal(await membership(late2.id), undefined);
});

test("the player fills in their own details: the player is created in the batch the staff chose, as an ordinary under-18 player", async () => {
  const blueOwner = await app.as("blueOwner");
  const me = await joined(blueOwner);
  const before = await me.client.post(`${API}/players/self-details`, {});
  assert.equal(before.status, 200, before.text);
  assert.deepEqual(before.json, { registered: false });
  const saved = await me.client.post(`${API}/players/self-register`, details);
  assert.equal(saved.status, 200, saved.text);
  const id = (saved.json as { id: string }).id;
  const [player] = await db().select().from(t.players).where(and(eq(t.players.academyId, "blue"), eq(t.players.id, id)));
  assert.equal(player.batchId, "blue-batch", "the batch comes from the link, not from the request");
  const [profile] = await db().select().from(t.profiles).where(and(eq(t.profiles.academyId, "blue"), eq(t.profiles.playerId, id)));
  assert.equal(profile.data.adult, false);
  assert.equal(profile.data.loginUserId, me.id);
  assert.equal(profile.data.selfUserId, null, "never an adult-controlled record");
  assert.equal(profile.data.birthDate, details.birthDate);
  // The player's own view: exactly their record, no other player of the academy.
  const view = (await me.client.get(API)).json as { players: { id: string; name: string }[]; actor: { role: string } };
  assert.deepEqual(view.players.map((p) => p.name), [details.name]);
  assert.equal(view.actor.role, "ADULT_PLAYER");
  // A second save changes contact details only: a different name or birth date is ignored.
  const again = await me.client.post(`${API}/players/self-register`, { ...details, version: 1, name: "Someone Else", birthDate: "2001-01-01", phone: "+91 90000 00000" });
  assert.equal(again.status, 200, again.text);
  const [after] = await db().select().from(t.profiles).where(and(eq(t.profiles.academyId, "blue"), eq(t.profiles.playerId, id)));
  assert.equal(after.data.phone, "+91 90000 00000");
  assert.equal(after.data.birthDate, details.birthDate);
  assert.equal((await db().select().from(t.players).where(and(eq(t.players.academyId, "blue"), eq(t.players.id, id))))[0].name, details.name);
  assert.equal((await me.client.post(`${API}/players/self-register`, { ...details, version: 1 })).status, 409, "a stale version is refused");
  // Staff correct the record in Players: the login survives.
  const blueView = (await blueOwner.get(API)).json as { players: { id: string; name: string; batchId: string; profile: Record<string, unknown> }[] };
  const staffCopy = blueView.players.find((p) => p.id === id)!;
  const staffSave = await blueOwner.post(`${API}/players/save`, {
    id, version: 2, name: "Aarya Link", batchId: staffCopy.batchId,
    profile: { adult: false, birthDate: details.birthDate, email: "", phone: "+91 90000 00000", notes: "Checked by staff", status: "ACTIVE", selfUserId: null, preferences: "" },
  });
  assert.equal(staffSave.status, 200, staffSave.text);
  const [kept] = await db().select().from(t.profiles).where(and(eq(t.profiles.academyId, "blue"), eq(t.profiles.playerId, id)));
  assert.equal(kept.data.loginUserId, me.id, "a staff save never unlinks the player's own login");
});

test("under-18 only, and one login makes one player", async () => {
  const blueOwner = await app.as("blueOwner");
  const me = await joined(blueOwner);
  const adult = await me.client.post(`${API}/players/self-register`, { ...details, birthDate: "1990-05-05" });
  assert.equal(adult.status, 422);
  assert.equal((adult.json as { code: string }).code, "PLAYER_NOT_UNDER_18");
  assert.equal((await me.client.post(`${API}/players/self-register`, { ...details, birthDate: "2999-01-01" })).status, 422, "a date in the future");
  assert.equal((await me.client.post(`${API}/players/self-register`, { ...details, name: "" })).status >= 400, true);
  const ok = await me.client.post(`${API}/players/self-register`, details);
  assert.equal(ok.status, 200, ok.text);
  const all = await db().select().from(t.profiles).where(eq(t.profiles.academyId, "blue"));
  assert.equal(all.filter((p) => p.data.loginUserId === me.id).length, 1);
});

test("two players who joined by link never see each other, and neither sees an existing player", async () => {
  const blueOwner = await app.as("blueOwner");
  const one = await joined(blueOwner);
  const two = await joined(blueOwner);
  await one.client.post(`${API}/players/self-register`, { ...details, name: "First Link Player" });
  await two.client.post(`${API}/players/self-register`, { ...details, name: "Second Link Player" });
  const seen = async (c: TestClient) => ((await c.get(API)).json as { players: { name: string }[] }).players.map((p) => p.name);
  assert.deepEqual(await seen(one.client), ["First Link Player"]);
  assert.deepEqual(await seen(two.client), ["Second Link Player"]);
  assert.ok(!(await one.client.get(API)).text.includes("Second Link Player"));
});

test("only a player's own account can use the self-service endpoints, and only if it came from a link", async () => {
  for (const [key, status] of [["blueOwner", 403], ["blueGuardian", 403], ["blueCoach", 403]] as const) {
    const c = await app.as(key);
    assert.equal((await c.post(`${API}/players/self-register`, details)).status, status, key);
    assert.equal((await c.post(`${API}/players/self-details`, {})).status, status, key);
  }
  assert.equal((await app.anonymous().post(`${API}/players/self-register`, details)).status, 401);
  // A player login that did not come from a link (a fixture adult-player account) has no batch to be placed in.
  const noLink = await app.as("adult");
  assert.equal((await noLink.post(`${API}/players/self-register`, details)).status, 403);
});

// ---- independent-review follow-ups ----
test("a link lasts at most 7 days, and a link row is never resent (its generated address must not surface)", async () => {
  const blueOwner = await app.as("blueOwner");
  assert.equal((await makeLink(blueOwner, { batchId: "blue-batch", expiresInDays: 8 })).status, 422);
  const link = await mine(blueOwner, { batchId: "blue-batch", expiresInDays: 7 });
  const resend = await blueOwner.post(`${API}/invitations/resend`, { id: link.id });
  assert.equal(resend.status, 422, resend.text);
  assert.equal((resend.json as { code: string }).code, "PLAYER_LINK_NO_RESEND");
  assert.ok(!resend.text.includes("links.invalid"));
  // The link still works once afterwards: the refused resend changed nothing.
  const person = await registered(email("after-resend"));
  assert.equal((await accept(person.client, tokenOf(link.link))).status, 200);
});

test("a player whose record was erased cannot create a new record without staff", async () => {
  const blueOwner = await app.as("blueOwner");
  const me = await joined(blueOwner);
  assert.equal((await me.client.post(`${API}/players/self-register`, details)).status, 200);
  // Erasure blanks the profile, including the login reference.
  const rows = await db().select().from(t.profiles).where(eq(t.profiles.academyId, "blue"));
  const mineRow = rows.find((p) => p.data.loginUserId === me.id)!;
  await db()
    .update(t.profiles)
    .set({ data: { ...mineRow.data, loginUserId: null } })
    .where(and(eq(t.profiles.academyId, "blue"), eq(t.profiles.playerId, mineRow.playerId)));
  const again = await me.client.post(`${API}/players/self-register`, details);
  assert.equal(again.status, 409, again.text);
  assert.equal((again.json as { code: string }).code, "ALREADY_REGISTERED");
});

