import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { config } from "../src/shared/config";
import { TERMS_VERSION } from "../src/modules/identity/onboarding-policy";
import { hashInvitationToken } from "../src/modules/invitations/token";
import { CANARY, FIXTURE_PASSWORD, ROLES, ROLE_USER, SUBJECT_IDS, USERS, addFixtureUser, type AcademyId, type Role } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, NEW_PASSWORD, signedIn, unique } from "./helpers/accounts";
import { enroll } from "./helpers/mfa";
import { totpAt } from "./helpers/totp";
import type { TestClient } from "./helpers/client";

/**
 * Academy invitations (migration 0018): joining an academy is never implied by an email address. Real HTTP over the real
 * route handlers and the real Better Auth endpoints. No mail provider exists in this suite and none is called.
 */
for (const name of ["EMAIL_PROVIDER", "RESEND_API_KEY", "ZEPTOMAIL_TOKEN", "ZEPTOMAIL_API_URL", "EMAIL_FROM"]) delete process.env[name];
const mailCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (/resend\.com|zeptomail\./i.test(url)) {
    mailCalls.push(url);
    return new Response("{}", { status: 500 });
  }
  return realFetch(input, init);
}) as typeof fetch;

let app: Harness;
let owner: Awaited<ReturnType<typeof enroll>>;
before(async () => {
  app = await startHarness("invitations-http");
  owner = await enroll(app, USERS.owner);
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  globalThis.fetch = realFetch;
  await app?.stop();
}, { timeout: HOOK_TIMEOUT });

/** The fixture owner has an authenticator (enrolled in before()), so a plain password sign-in no longer works: reuse that session. */
const asOwner = async () => owner.client;
const db = () => database();
const API = "/api/academy";
const AUTH = "/api/auth";
const PREVIEW = `${AUTH}/invitations/preview`;
const ACCEPT = `${AUTH}/invitations/accept`;
const DAY = 86_400_000;
const GREEN = "Fixture Green Academy";
const BLUE = "Fixture Blue Academy";
const email = (tag = "p") => `${tag}-${unique()}-${Date.now().toString(36)}@example.test`;

type Created = { id: string; token: string; link: string; expiresAt: string; role: string; kind: string; email: string };
const create = (c: TestClient, body: Record<string, unknown>) => c.post(`${API}/invitations/create`, body);
const made = async (c: TestClient, body: Record<string, unknown>) => {
  const r = await create(c, body);
  assert.equal(r.status, 200, r.text);
  return r.json as Created;
};
const staff = (to: string, role = "COACH", extra: Record<string, unknown> = {}) => ({ email: to, kind: "STAFF", role, ...extra });
const accept = (c: TestClient, token: string) => c.post(ACCEPT, { token });
const preview = (token: string, c: TestClient = app.anonymous()) => c.post(PREVIEW, { token });
const list = async (c: TestClient) => ((await c.get(`${API}/invitations`)).json as { invitations: Row[] }).invitations;
type Row = { id: string; email: string; kind: string; role: string; status: string; playerName: string | null; invitedBy: string };
const row = async (id: string) => (await db().select().from(t.academyInvitations).where(eq(t.academyInvitations.id, id)))[0];
const memberOf = async (userId: string, academyId: string) =>
  (await db().select().from(t.memberships).where(and(eq(t.memberships.userId, userId), eq(t.memberships.academyId, academyId))))[0];
const usersWith = async (address: string) => (await db().select().from(t.user).where(eq(t.user.email, address))).length;
const events = async (event: string) => db().select().from(t.securityEvent).where(eq(t.securityEvent.event, event));
const clearClaims = () => db().delete(t.totpUsed).where(eq(t.totpUsed.userId, USERS.owner.id));
const stepUp = async () => {
  await clearClaims();
  return { ownerPassword: FIXTURE_PASSWORD, mfaCode: totpAt(owner.uri.secret, 0) };
};
/** A public account created exactly as a visitor would (no email, no provider), then signed in. */
async function registered(address: string) {
  const password = NEW_PASSWORD();
  const r = await app.anonymous().post(`${AUTH}/onboarding/signup`, { name: "Invited Person", email: address, password, acceptTerms: true, termsVersion: TERMS_VERSION });
  assert.equal(r.status, 200, r.text);
  return { password, client: await signedIn(app, address, password) };
}
async function existing(memberships: { academyId: AcademyId; role: Role }[]) {
  const id = `inv-${unique()}`;
  const account = await addFixtureUser(id, memberships);
  return { ...account, client: await signedIn(app, account.email) };
}
/** An invitation that is already past its expiry (the database refuses to edit an expiry, so it is planted that way). */
async function plant(address: string, token: string, over: Partial<typeof t.academyInvitations.$inferInsert> = {}) {
  const [r] = await db()
    .insert(t.academyInvitations)
    .values({
      academyId: "green", inviteeEmail: address, kind: "STAFF", role: "COACH", invitedByUserId: USERS.owner.id,
      tokenHash: hashInvitationToken(token, config().BETTER_AUTH_SECRET),
      createdAt: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() - DAY),
      ...over,
    })
    .returning();
  return r;
}
const wanted = (n: number) => Array.from({ length: n }, (_, i) => i);

test("EXISTING account: an owner of another academy invites it, the person reviews and explicitly accepts, gains the new role, and keeps every existing membership", async () => {
  const person = await existing([{ academyId: "green", role: "COACH" }]);
  const blueOwner = await app.as("blueOwner");
  const inv = await made(blueOwner, staff(person.email, "FINANCE"));
  // Nothing happened yet: an invitation grants nothing.
  assert.equal(await memberOf(person.id, "blue"), undefined, "no membership from the invitation alone");
  assert.deepEqual((await list(blueOwner)).map((r) => [r.email, r.role, r.status]), [[person.email, "FINANCE", "PENDING"]]);

  // The review screen's data: what is being offered, to a masked address, never a person or an identifier.
  const p = await preview(inv.token);
  assert.equal(p.status, 200);
  assert.deepEqual({ ...(p.json as object), expiresAt: undefined, invitedBy: undefined, emailHint: undefined },
    { status: "PENDING", academyName: BLUE, kind: "STAFF", role: "FINANCE", relationship: null, emailHint: undefined, invitedBy: undefined, expiresAt: undefined });
  assert.ok(!p.text.includes(person.email) && !p.text.includes(person.id), "the address is masked");

  const before = { green: await memberOf(person.id, "green") };
  const done = await accept(person.client, inv.token);
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(done.json, { academyId: "blue", academyName: BLUE, role: "FINANCE", kind: "STAFF", alreadyAccepted: false });
  assert.deepEqual(await memberOf(person.id, "blue"), { userId: person.id, academyId: "blue", role: "FINANCE", active: true, displayName: null });
  assert.deepEqual(await memberOf(person.id, "green"), before.green, "the existing membership and role are unchanged");
  assert.equal(await usersWith(person.email), 1, "no duplicate account");
  const stored = await row(inv.id);
  assert.deepEqual([stored.status, stored.acceptedByUserId], ["ACCEPTED", person.id]);
  assert.ok(stored.acceptedAt);

  // Academy switching after acceptance: the session landed in the new academy, and the old one is one switch away.
  assert.deepEqual(((await person.client.get(`${API}/identity`)).json as { role: string; academy: { name: string } }).academy.name, BLUE);
  const listing = (await person.client.get(`${AUTH}/account/academies`)).json as { academies: { academyId: string; role: string }[] };
  assert.deepEqual(listing.academies.map((a) => [a.academyId, a.role]).sort(), [["blue", "FINANCE"], ["green", "COACH"]]);
  await person.client.post(`${AUTH}/account/select-academy`, { academyId: "green" });
  assert.equal(((await person.client.get(`${API}/identity`)).json as { role: string }).role, "COACH");
  assert.equal((await list(blueOwner))[0].status, "ACCEPTED");
});

test("NEW account: the invitee registers with no mail provider, is still unverified and unassigned, then accepts and gets exactly the invited role; no duplicate account", async () => {
  const address = email("new");
  const inv = await made(await asOwner(), staff(address, "HEAD_COACH"));
  assert.equal((await preview(inv.token)).status, 200, "the preview needs no account");
  const { client } = await registered(address);
  assert.equal(code(await client.get(`${API}/identity`)), "NO_MEMBERSHIP", "registering alone grants nothing, even for the invited address");
  assert.equal((await row(inv.id)).status, "PENDING");
  const done = await accept(client, inv.token);
  assert.equal(done.status, 200, done.text);
  const [person] = await db().select().from(t.user).where(eq(t.user.email, address));
  assert.equal(person.emailVerified, false, "still unverified: accepting never needed (or gave) a verified address");
  assert.equal(await usersWith(address), 1);
  assert.equal(((await client.get(`${API}/identity`)).json as { role: string }).role, "HEAD_COACH");
  assert.equal((await memberOf(person.id, "green")).role, "HEAD_COACH");
  assert.deepEqual(mailCalls, [], "no mail provider was reached");
});

test("an email address alone never joins an academy: a matching account WITHOUT the token, and the token on a DIFFERENT account, both get nothing", async () => {
  const address = email("match");
  const inv = await made(await asOwner(), staff(address, "COACH"));
  const { client } = await registered(address);
  assert.equal(code(await client.get(`${API}/identity`)), "NO_MEMBERSHIP");
  assert.equal(await memberOf((await db().select().from(t.user).where(eq(t.user.email, address)))[0].id, "green"), undefined);

  const stranger = await existing([{ academyId: "blue", role: "COACH" }]);
  const r = await accept(stranger.client, inv.token);
  assert.equal(r.status, 403, r.text);
  assert.equal(code(r), "WRONG_ACCOUNT");
  assert.equal(await memberOf(stranger.id, "green"), undefined, "the token on the wrong account creates nothing");
  assert.equal((await row(inv.id)).status, "PENDING", "and it stays usable by the right person");
  const refusals = (await events("INVITATION_REFUSED")).filter((e) => e.actorId === stranger.id);
  assert.deepEqual(refusals.map((e) => [e.academyId, (e.detail as { reason: string }).reason]), [["green", "WRONG_ACCOUNT"]]);
  assert.equal((await accept(client, inv.token)).status, 200, "the addressed account still accepts");
  // letter case in the address is not a way around it, nor a way to fail
  const mixed = email("Case");
  const inv2 = await made(await asOwner(), staff(mixed.toUpperCase(), "COACH"));
  assert.equal((await row(inv2.id)).inviteeEmail, mixed.toLowerCase());
});

test("invalid tokens: anything that is not a live token answers identically and reveals nothing, on preview and on accept", async () => {
  const person = await existing([]);
  const bodies = new Set<string>();
  for (const token of ["", "x", "not-a-token", "A".repeat(43), "a".repeat(44), "../../etc/passwd", "A".repeat(43) + "\u0000", "' OR '1'='1"]) {
    const a = await preview(token);
    const b = await accept(person.client, token);
    assert.equal(a.status, 404, `preview ${JSON.stringify(token)}`);
    assert.equal(b.status, 404, `accept ${JSON.stringify(token)}`);
    assert.equal(code(a), "INVALID_INVITATION");
    assert.equal(code(b), "INVALID_INVITATION");
    bodies.add(a.text);
    bodies.add(b.text);
  }
  assert.equal(bodies.size, 1, "one answer for every kind of bad token");
  assert.equal((await accept(app.anonymous(), "A".repeat(43))).status, 401, "accepting needs a signed-in person");
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, person.id))).length, 0);
});

test("EXPIRED: an expired invitation cannot be accepted, is settled as EXPIRED, and the address can then be invited again", async () => {
  const address = email("exp");
  const token = "E".repeat(43);
  const planted = await plant(address, token);
  const { client } = await registered(address);
  assert.equal(((await preview(token)).json as { status: string }).status, "EXPIRED");
  const r = await accept(client, token);
  assert.equal(r.status, 410, r.text);
  assert.equal(code(r), "INVITATION_EXPIRED");
  assert.equal((await row(planted.id)).status, "EXPIRED", "the lapse is recorded");
  assert.equal(code(await client.get(`${API}/identity`)), "NO_MEMBERSHIP");
  // an expired-but-unsettled invitation does not block a fresh one
  const stale = email("stale");
  await plant(stale, "S".repeat(43));
  const fresh = await create(await asOwner(), staff(stale));
  assert.equal(fresh.status, 200, fresh.text);
  assert.deepEqual((await list(await asOwner())).filter((x) => x.email === stale).map((x) => x.status).sort(), ["EXPIRED", "PENDING"]);
});

test("REVOKED and REPLAY: a withdrawn invitation cannot be accepted; an accepted one cannot be used again (idempotent for the same person, refused for anyone else); a used token creates no second membership", async () => {
  const owner1 = await asOwner();
  const address = email("rev");
  const gone = await made(owner1, staff(address, "COACH"));
  const withdrawn = await owner1.post(`${API}/invitations/revoke`, { id: gone.id });
  assert.equal(withdrawn.status, 200, withdrawn.text);
  const { client } = await registered(address);
  assert.equal(((await preview(gone.token)).json as { status: string }).status, "REVOKED");
  const r = await accept(client, gone.token);
  assert.deepEqual([r.status, code(r)], [410, "INVITATION_REVOKED"]);
  assert.equal(code(await client.get(`${API}/identity`)), "NO_MEMBERSHIP");
  assert.equal((await owner1.post(`${API}/invitations/revoke`, { id: gone.id })).status, 409, "withdrawing twice");

  // replay of an accepted invitation
  const ok = await made(owner1, staff(address, "COACH"));
  assert.equal((await accept(client, ok.token)).status, 200);
  const again = await accept(client, ok.token);
  assert.equal(again.status, 200, "the same person repeating it (a double click) is harmless");
  assert.equal((again.json as { alreadyAccepted: boolean }).alreadyAccepted, true);
  assert.equal((await db().select().from(t.memberships).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.role, "COACH"), eq(t.memberships.userId, (await db().select().from(t.user).where(eq(t.user.email, address)))[0].id)))).length, 1);
  const other = await existing([]);
  const stolen = await accept(other.client, ok.token);
  assert.deepEqual([stolen.status, code(stolen)], [409, "INVITATION_ALREADY_USED"], "a used token is dead for everybody else");
  assert.equal(await memberOf(other.id, "green"), undefined);
  assert.equal((await owner1.post(`${API}/invitations/revoke`, { id: ok.id })).status, 409, "an accepted invitation cannot be withdrawn");
});

test("CONCURRENT acceptance: many simultaneous requests for one invitation create exactly one membership and exactly one real acceptance", async () => {
  const address = email("race");
  const inv = await made(await asOwner(), staff(address, "COACH"));
  const { client } = await registered(address);
  const results = await Promise.all(wanted(8).map(() => accept(client.clone(), inv.token)));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
  assert.equal(results.filter((r) => (r.json as { alreadyAccepted: boolean }).alreadyAccepted === false).length, 1, "exactly one acceptance did the work");
  const [person] = await db().select().from(t.user).where(eq(t.user.email, address));
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, person.id))).length, 1);
  assert.equal((await events("INVITATION_ACCEPTED")).filter((e) => e.actorId === person.id).length, 1, "audited once");
});

test("CONCURRENT with a member change: an invitation accepted while the person is being added by the owner makes one membership and one clean refusal, never two", async () => {
  const person = await existing([]);
  const inv = await made(await asOwner(), staff(person.email, "COACH"));
  const o = await asOwner();
  const [viaInvite, viaOwner] = await Promise.all([
    accept(person.client, inv.token),
    o.post(`${API}/settings/member`, { name: "Fixture", email: person.email, role: "COACH", active: true, professionalAttestation: "" }),
  ]);
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, person.id))).length, 1);
  assert.ok(viaInvite.status === 200 || viaInvite.status === 409, String(viaInvite.status));
  assert.ok(viaOwner.status === 409, "the owner's route refuses an address that already has an account");
});

test("DUPLICATES: inviting somebody who already belongs is refused; a membership added after the invitation makes it fail cleanly; a guardian may be invited for another child", async () => {
  const o = await asOwner();
  const member = await existing([{ academyId: "green", role: "COACH" }]);
  const r = await create(o, staff(member.email, "FINANCE"));
  assert.deepEqual([r.status, code(r)], [409, "ALREADY_MEMBER"]);
  const deactivated = await existing([{ academyId: "green", role: "COACH" }]);
  await db().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, deactivated.id));
  assert.equal(code(await create(o, staff(deactivated.email))), "ALREADY_MEMBER", "a switched-off member is restored by the owner, not re-invited");

  const later = await existing([]);
  const inv = await made(o, staff(later.email, "FINANCE"));
  await db().insert(t.memberships).values({ academyId: "green", userId: later.id, role: "COACH" });
  const accepted = await accept(later.client, inv.token);
  assert.deepEqual([accepted.status, code(accepted)], [409, "ALREADY_MEMBER"]);
  assert.equal((await memberOf(later.id, "green")).role, "COACH", "the invitation never overwrote the role they already had");
  assert.equal((await row(inv.id)).status, "PENDING", "and is left for the owner to withdraw");

  const dup = email("dup");
  await made(o, staff(dup));
  assert.deepEqual([(await create(o, staff(dup, "ADMIN"))).status], [409], "one open invitation per address");
  assert.equal(code(await create(o, staff(dup, "ADMIN"))), "DUPLICATE_INVITATION");
});

test("AUTHORIZATION: only an owner creates, lists and withdraws invitations; every other role, anonymous callers and cross-site requests are refused and nothing is stored", async () => {
  const o = await asOwner();
  const target = await made(o, staff(email("auth")));
  const before = await db().select().from(t.academyInvitations);
  for (const role of ROLES) {
    if (role === "OWNER") continue;
    const c = await app.as(ROLE_USER[role]);
    assert.equal((await create(c, staff(email("deny")))).status, 403, `${role} create`);
    assert.equal((await c.get(`${API}/invitations`)).status, 403, `${role} list`);
    assert.equal((await c.post(`${API}/invitations/revoke`, { id: target.id })).status, 403, `${role} revoke`);
  }
  assert.equal((await app.anonymous().get(`${API}/invitations`)).status, 401);
  assert.equal((await app.anonymous().post(`${API}/invitations/create`, staff(email()))).status, 401);
  assert.equal((await o.post(`${API}/invitations/create`, staff(email()), { origin: "https://evil.example" })).status, 403);
  assert.equal((await db().select().from(t.academyInvitations)).length, before.length, "nothing was stored");
  assert.equal((await row(target.id)).status, "PENDING");
});

test("ROLES and KINDS: only the six staff roles can be invited by a staff invitation; the role is never chosen by the invitee; a child player cannot be invited", async () => {
  const o = await asOwner();
  for (const role of ["ADMIN", "HEAD_COACH", "COACH", "FINANCE"]) assert.equal((await create(o, staff(email(), role))).status, 200, role);
  for (const bad of [{ role: "GUARDIAN" }, { role: "ADULT_PLAYER" }, { role: "PLAYER" }, { role: "SUPERUSER" }, { role: "owner" }, {}, { role: "COACH", playerId: "x" }])
    assert.ok([422].includes((await create(o, { email: email(), kind: "STAFF", ...bad })).status), JSON.stringify(bad));
  assert.equal((await create(o, { email: "not-an-address", kind: "STAFF", role: "COACH" })).status, 422);
  assert.equal((await create(o, { email: email(), kind: "CHILD_PLAYER", role: "COACH" })).status, 422);
  const nutrition = await create(o, staff(email(), "NUTRITION_PRO"));
  assert.equal(nutrition.status, 422, "the professional authorisation is required, as when an owner creates that login directly");
  assert.equal((await create(o, staff(email(), "NUTRITION_PRO", { professionalAttestation: "Registered dietitian, licence on file" }))).status, 200);
  // the invitee's own body cannot choose a role: accepting carries only the token
  const person = await existing([]);
  const inv = await made(o, staff(person.email, "COACH"));
  const r = await person.client.post(ACCEPT, { token: inv.token, role: "OWNER", academyId: "blue" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([(await memberOf(person.id, "green")).role, await memberOf(person.id, "blue")], ["COACH", undefined]);
});

test("OWNER invitations keep the owner step-up: password and authenticator code are required to create one; accepting makes a second owner and is audited; a demoted inviter's invitation dies", async () => {
  const o = await asOwner();
  const address = email("owner-inv");
  const ownerBody = staff(address, "OWNER");
  const before = (await db().select().from(t.academyInvitations)).length;
  for (const bad of [{}, { ownerPassword: FIXTURE_PASSWORD }, { mfaCode: "123456" }, { ownerPassword: "wrong-password-123", mfaCode: totpAt(owner.uri.secret, 0) }, { ownerPassword: FIXTURE_PASSWORD, mfaCode: "000000" }]) {
    await clearClaims();
    const r = await create(o, { ...ownerBody, ...bad });
    assert.ok([403, 422, 429].includes(r.status), `${JSON.stringify(Object.keys(bad))} -> ${r.status}`);
  }
  assert.equal((await db().select().from(t.academyInvitations)).length, before, "no invitation without the step-up");
  await clearClaims();
  await db().delete(t.signInThrottle);
  const inv = await made(o, { ...ownerBody, ...(await stepUp()) });
  assert.equal(inv.role, "OWNER");
  const { client } = await registered(address);
  const owners = async () => (await db().select().from(t.memberships).where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.role, "OWNER"), eq(t.memberships.active, true)))).length;
  const owners0 = await owners();
  assert.equal((await accept(client, inv.token)).status, 200);
  assert.equal(await owners(), owners0 + 1, "a second (independent) owner now exists");
  const newOwnerId = (await db().select().from(t.user).where(eq(t.user.email, address)))[0].id;
  const granted = (await events("OWNER_GRANTED")).filter((e) => (e.detail as { targetUserId?: string }).targetUserId === newOwnerId);
  assert.equal(granted.length, 1);
  assert.deepEqual([granted[0].actorId, (granted[0].detail as { method: string }).method], [USERS.owner.id, "invitation"]);

  // an invitation whose author has since lost the authority cannot be used
  const inviter = await existing([{ academyId: "green", role: "OWNER" }]);
  const second = await enroll(app, inviter);
  // enrolling consumed this window's code; clear that claim (as the other step-up suites do) so the same window can be used once more
  await db().delete(t.totpUsed).where(eq(t.totpUsed.userId, inviter.id));
  const code1 = totpAt(second.uri.secret, 0);
  await db().delete(t.signInThrottle);
  const lateAddress = email("late");
  const r = await create(second.client, { ...staff(lateAddress, "OWNER"), ownerPassword: FIXTURE_PASSWORD, mfaCode: code1 });
  assert.equal(r.status, 200, r.text);
  await db().update(t.memberships).set({ role: "COACH" }).where(and(eq(t.memberships.userId, inviter.id), eq(t.memberships.academyId, "green")));
  const late = await registered(lateAddress);
  const dead = await accept(late.client, (r.json as Created).token);
  assert.deepEqual([dead.status, code(dead)], [410, "INVITATION_NO_LONGER_VALID"]);
  assert.equal(await memberOf((await db().select().from(t.user).where(eq(t.user.email, lateAddress)))[0].id, "green"), undefined);
});

test("LAST-OWNER protection is untouched: the database still refuses to leave an academy without an active owner", async () => {
  const owners = (await db().select().from(t.memberships).where(and(eq(t.memberships.academyId, "quiet"), eq(t.memberships.role, "OWNER"), eq(t.memberships.active, true)))).length;
  assert.ok(owners >= 1);
  await assert.rejects(
    () => db().update(t.memberships).set({ role: "COACH" }).where(and(eq(t.memberships.academyId, "quiet"), eq(t.memberships.role, "OWNER"))),
    /OWNER_REQUIRED|owner/i,
    "the database still refuses to leave an academy without an owner",
  );
});

test("GUARDIAN invitations are not staff memberships: they create a GUARDIAN membership and a link with NO consent granted, never a role chosen by the invitee; a guardian can be invited for a second child", async () => {
  const o = await asOwner();
  const child = SUBJECT_IDS.childA;
  const r = await create(o, { email: email("g"), kind: "GUARDIAN", playerId: child });
  assert.equal(r.status, 422, "the relationship is required");
  assert.equal((await create(o, { email: email("g"), kind: "GUARDIAN", relationship: "Mother" })).status, 422, "the player is required");
  assert.equal((await create(o, { email: email("g"), kind: "GUARDIAN", role: "OWNER", playerId: child, relationship: "Mother" })).status, 422, "a guardian invitation fixes the role");
  assert.equal((await create(o, { email: email("g"), kind: "GUARDIAN", playerId: SUBJECT_IDS.blue, relationship: "Mother" })).status, 404, "another academy's player");
  assert.equal((await create(o, { email: email("g"), kind: "GUARDIAN", playerId: "no-such-player", relationship: "Mother" })).status, 404);

  const address = email("guardian");
  const inv = await made(o, { email: address, kind: "GUARDIAN", playerId: child, relationship: "Mother" });
  assert.equal(inv.role, "GUARDIAN");
  const p = await preview(inv.token);
  assert.ok(!p.text.includes(CANARY.childA.name), "a token holder is not told the child's name");
  const { client } = await registered(address);
  assert.equal((await accept(client, inv.token)).status, 200);
  const [person] = await db().select().from(t.user).where(eq(t.user.email, address));
  assert.equal((await memberOf(person.id, "green")).role, "GUARDIAN");
  const [link] = await db().select().from(t.guardianLinks).where(and(eq(t.guardianLinks.userId, person.id), eq(t.guardianLinks.playerId, child)));
  assert.deepEqual([link.active, link.relationship, link.consent], [true, "Mother", { portal: false, email: false, whatsapp: false }], "linked, with nothing granted");
  assert.equal((await db().select().from(t.consentEvents).where(eq(t.consentEvents.subjectUserId, person.id))).length, 0, "no consent was recorded on anyone's behalf");
  assert.equal((await db().select().from(t.guardianAccessGrants).where(eq(t.guardianAccessGrants.guardianUserId, person.id))).length, 0);

  // a guardian who already belongs is invited for another child: only the link is added
  const second = await made(o, { email: address, kind: "GUARDIAN", playerId: SUBJECT_IDS.childB, relationship: "Mother" });
  assert.equal((await accept(client, second.token)).status, 200);
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, person.id))).length, 1, "still one membership");
  assert.equal((await db().select().from(t.guardianLinks).where(eq(t.guardianLinks.userId, person.id))).length, 2);
  // ...but not twice for the same child
  assert.equal(code(await create(o, { email: address, kind: "GUARDIAN", playerId: child, relationship: "Mother" })), "ALREADY_MEMBER");
  // and a staff account cannot be turned into a guardian by invitation
  const coach = await existing([{ academyId: "green", role: "COACH" }]);
  assert.equal(code(await create(o, { email: coach.email, kind: "GUARDIAN", playerId: child, relationship: "Father" })), "ALREADY_MEMBER");
});

test("the WhatsApp number typed on the accept page is saved to the account in the same step as joining; a bad number joins nothing and leaves the invitation open", async () => {
  const o = await asOwner();
  const address = email("phone");
  const inv = await made(o, { email: address, kind: "GUARDIAN", playerId: SUBJECT_IDS.childA, relationship: "Father" });
  const { client } = await registered(address);
  const [person] = await db().select().from(t.user).where(eq(t.user.email, address));
  assert.equal(person.phone, null, "no number before accepting");
  const bad = await client.post(ACCEPT, { token: inv.token, phone: "12" });
  assert.equal(bad.status, 422, bad.text);
  assert.equal(code(bad), "INVALID_PHONE");
  assert.equal(await memberOf(person.id, "green"), undefined, "a refused number joins nobody");
  assert.equal((await row(inv.id)).status, "PENDING", "the invitation stays open for another try");
  const ok = await client.post(ACCEPT, { token: inv.token, phone: "98765 43210" });
  assert.equal(ok.status, 200, ok.text);
  const [after] = await db().select().from(t.user).where(eq(t.user.id, person.id));
  assert.equal(after.phone, "+919876543210", "read in the academy's own country and kept as E.164");
  assert.equal((await memberOf(person.id, "green")).role, "GUARDIAN");
  const mine = await client.post(`${API}/communications/my-phone`, {});
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(mine.json, { last4: "3210" }, "the family portal can show that a number is saved, without the number");
  // leaving the field empty still joins and keeps whatever number the account had
  const second = await made(o, { email: address, kind: "GUARDIAN", playerId: SUBJECT_IDS.childB, relationship: "Father" });
  assert.equal((await accept(client, second.token)).status, 200);
  assert.equal((await db().select().from(t.user).where(eq(t.user.id, person.id)))[0].phone, "+919876543210");
});

test("ADULT PLAYER invitations are refused: players are under 18 and have no login of their own", async () => {
  const o = await asOwner();
  const r = await create(o, { email: email("adult"), kind: "ADULT_PLAYER" });
  assert.equal(r.status, 422, r.text);
  assert.match(r.text, /under 18/);
  const rows = await db().select().from(t.academyInvitations).where(eq(t.academyInvitations.kind, "ADULT_PLAYER"));
  assert.equal(rows.length, 0, "nothing was created");
});

test("ONE person, several academies: invitations from different academies coexist, are independent, and each acceptance adds a membership and switches the session", async () => {
  const address = email("multi");
  const fromGreen = await made(await asOwner(), staff(address, "COACH"));
  const fromBlue = await made(await app.as("blueOwner"), staff(address, "FINANCE"));
  assert.notEqual(fromGreen.token, fromBlue.token);
  const { client } = await registered(address);
  assert.equal(((await preview(fromGreen.token)).json as { academyName: string }).academyName, GREEN);
  assert.equal(((await preview(fromBlue.token)).json as { academyName: string }).academyName, BLUE);
  assert.equal((await accept(client, fromGreen.token)).status, 200);
  assert.equal(((await client.get(`${API}/identity`)).json as { academy: { name: string } }).academy.name, GREEN);
  assert.equal((await accept(client, fromBlue.token)).status, 200);
  assert.deepEqual(((await client.get(`${API}/identity`)).json as { role: string; academy: { name: string } }).academy.name, BLUE);
  const mine = (await client.get(`${AUTH}/account/academies`)).json as { academies: { name: string; role: string; current: boolean }[] };
  assert.deepEqual(mine.academies.map((a) => [a.name, a.role, a.current]).sort(), [[BLUE, "FINANCE", true], [GREEN, "COACH", false]]);
  const [person] = await db().select().from(t.user).where(eq(t.user.email, address));
  assert.equal(await usersWith(address), 1);
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, person.id))).length, 2);
  // each academy's own list shows only its own invitation
  assert.deepEqual((await list(await asOwner())).filter((r) => r.email === address).map((r) => r.role), ["COACH"]);
  assert.deepEqual((await list(await app.as("blueOwner"))).filter((r) => r.email === address).map((r) => r.role), ["FINANCE"]);
});

test("CROSS-ACADEMY: an owner sees and withdraws only their own academy's invitations; another academy's id answers exactly like an unknown one", async () => {
  const blueInv = await made(await app.as("blueOwner"), staff(email("x")));
  const o = await asOwner();
  assert.ok(!(await list(o)).some((r) => r.id === blueInv.id));
  const foreign = await o.post(`${API}/invitations/revoke`, { id: blueInv.id });
  const unknown = await o.post(`${API}/invitations/revoke`, { id: crypto.randomUUID() });
  assert.deepEqual([foreign.status, unknown.status], [404, 404]);
  assert.equal(foreign.text, unknown.text, "no hint that the invitation exists elsewhere");
  assert.equal((await row(blueInv.id)).status, "PENDING");
  assert.equal((await o.post(`${API}/invitations/revoke`, { id: "not-a-uuid" })).status, 422);
  // an academy id in the request is ignored: the invitation is created in the caller's own academy
  const r = await o.post(`${API}/invitations/create`, { ...staff(email("y")), academyId: "blue", academy_id: "blue" });
  assert.equal(r.status, 200, r.text);
  assert.equal((await row((r.json as Created).id)).academyId, "green");
});

test("TOKEN HYGIENE: a token exists in plaintext only in the creation answer; the database, the list, the security log and the audit trail never hold it", async () => {
  const o = await asOwner();
  const inv = await made(o, staff(email("hygiene"), "COACH"));
  assert.match(inv.link, new RegExp(`/invite#${inv.token}$`), "the link carries the token in the fragment, never a path or query");
  assert.ok(!inv.link.includes("?"));
  const everything = JSON.stringify([
    await db().select().from(t.academyInvitations),
    await db().select().from(t.securityEvent),
    await db().select().from(t.audit),
    await db().select().from(t.authEmailOutbox),
  ]);
  assert.ok(!everything.includes(inv.token), "no stored copy of the token");
  const stored = await row(inv.id);
  assert.equal(stored.tokenHash, hashInvitationToken(inv.token, config().BETTER_AUTH_SECRET));
  assert.notEqual(stored.tokenHash, inv.token);
  const listed = (await o.get(`${API}/invitations`)).text;
  assert.ok(!listed.includes(inv.token) && !listed.includes(stored.tokenHash), "the list shows neither");
  const other = await existing([]);
  const wrong = await accept(other.client, inv.token);
  assert.ok(!wrong.text.includes(inv.token), "errors never echo it");
  assert.ok(!JSON.stringify(await events("INVITATION_REFUSED")).includes(inv.token));
  assert.equal((await o.get(`${API}/security-events?limit=100`)).text.includes(inv.token), false);
  assert.deepEqual(mailCalls, [], "nothing was emailed");
});

test("AUDIT: creating, withdrawing, accepting and a refusal are each recorded in the academy's own log, without addresses or tokens", async () => {
  const o = await asOwner();
  const person = await existing([]);
  const a = await made(o, staff(person.email, "COACH"));
  const b = await made(o, staff(email("w")));
  await o.post(`${API}/invitations/revoke`, { id: b.id });
  await accept(person.client, a.token);
  const log = ((await o.get(`${API}/security-events?limit=100`)).json as { events: { event: string; detail: Record<string, unknown> }[] }).events;
  for (const name of ["INVITATION_CREATED", "INVITATION_REVOKED", "INVITATION_ACCEPTED"]) assert.ok(log.some((e) => e.event === name), name);
  const text = JSON.stringify(log.filter((e) => e.event.startsWith("INVITATION")));
  assert.ok(!text.includes(person.email) && !text.includes("@example.test"), "no address in the log");
  assert.ok(log.find((e) => e.event === "INVITATION_ACCEPTED")!.detail.toRole === "COACH");
  // the other academy's log shows none of this
  const blueLog = JSON.stringify(((await (await app.as("blueOwner")).get(`${API}/security-events?limit=100`)).json as { events: unknown[] }).events);
  assert.ok(!blueLog.includes(a.id), "another academy's log is not touched");
});

test("an account gate is answered first: a person who must still replace a temporary password cannot accept", async () => {
  const person = await existing([]);
  const inv = await made(await asOwner(), staff(person.email, "COACH"));
  await db().insert(t.temporaryCredential).values({ userId: person.id, source: "MEMBER_CREATED", issuedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 3_600_000) });
  const r = await accept(person.client, inv.token);
  assert.equal(r.status, 403);
  assert.equal(code(r), "PASSWORD_CHANGE_REQUIRED");
  assert.equal(await memberOf(person.id, "green"), undefined);
  assert.equal((await row(inv.id)).status, "PENDING");
});

test("preview and accept are rate limited", async () => {
  const client = app.anonymous("10.77.0.1");
  const statuses: number[] = [];
  for (let i = 0; i < 24; i++) statuses.push((await preview("Z".repeat(43), client)).status);
  assert.ok(statuses.includes(429), statuses.join());
  assert.equal(statuses[0], 404);
});

const resend = (c: TestClient, id: string, extra: Record<string, unknown> = {}) => c.post(`${API}/invitations/resend`, { id, ...extra });
const guardianInvite = (to: string, playerId: string, relationship = "Mother") => ({ email: to, kind: "GUARDIAN", playerId, relationship });

test("RESEND: the old link dies at once, the new one works, a parent keeps one account; an accepted invitation cannot be resent; only an owner may", async () => {
  const o = await asOwner();
  const address = email("resend");
  const first = await made(o, guardianInvite(address, SUBJECT_IDS.childA));
  // a duplicate create now points to Resend instead of a bare refusal
  const dup = await create(o, guardianInvite(address, SUBJECT_IDS.childA));
  assert.equal(code(dup), "DUPLICATE_INVITATION");
  assert.match(JSON.stringify(dup.json), /Resend/);
  const again = await resend(o, first.id);
  assert.equal(again.status, 200, again.text);
  const second = again.json as Created & { resentFrom: string };
  assert.equal(second.resentFrom, first.id);
  assert.notEqual(second.token, first.token, "a new token is issued");
  assert.equal((await row(first.id)).status, "REVOKED", "the old invitation is withdrawn in the same step");
  assert.equal((await row(second.id)).status, "PENDING");
  assert.equal((await row(second.id)).playerId, SUBJECT_IDS.childA, "same player and relationship");
  assert.equal(((await preview(first.token)).json as { status: string }).status, "REVOKED");
  const { client } = await registered(address);
  const oldTry = await accept(client, first.token);
  assert.equal(oldTry.status, 410, "the withdrawn link no longer works");
  assert.equal(await memberOf((await db().select().from(t.user).where(eq(t.user.email, address)))[0].id, "green"), undefined);
  assert.equal((await accept(client, second.token)).status, 200, "the fresh link works");
  assert.equal(code(await resend(o, second.id)), "NOT_PENDING", "an accepted invitation cannot be resent");
  assert.equal((await db().select().from(t.user).where(eq(t.user.email, address))).length, 1, "no duplicate account");
  // an expired invitation can be resent too, and a coach cannot resend
  const expiredAddress = email("resend-expired");
  const planted = await plant(expiredAddress, `${unique()}${Date.now().toString(36)}`.padEnd(43, "x").slice(0, 43), { kind: "GUARDIAN", role: "GUARDIAN", playerId: SUBJECT_IDS.childB, relationship: "Father" });
  const fresh = await resend(o, planted.id);
  assert.equal(fresh.status, 200, fresh.text);
  const coach = await existing([{ academyId: "green", role: "COACH" }]);
  assert.equal((await resend(coach.client, (fresh.json as Created).id)).status, 403, "a coach cannot resend");
  assert.equal(code(await resend(o, "00000000-0000-4000-8000-000000000000")), "NOT_FOUND");
  assert.equal((await events("INVITATION_CREATED")).filter((e) => (e.detail as { resentFrom?: string }).resentFrom).length >= 2, true, "resends are recorded");
});

test("BULK invitation: each row follows every ordinary rule; one parent of two children ends with one account; a bad row does not stop the others", async () => {
  const o = await asOwner();
  const mum = email("bulk-mum");
  const r = await o.post(`${API}/invitations/bulk`, {
    rows: [
      { playerId: SUBJECT_IDS.childA, email: mum, relationship: "Mother", who: "Asha", phone: "+919876543210" },
      { playerId: SUBJECT_IDS.childB, email: mum, relationship: "Mother", who: "Asha", phone: "+919876543210" },
      { playerName: CANARY.childA.name, email: email("bulk-dad"), relationship: "Father" },
      { playerId: "no-such-player", email: email("bulk-x"), relationship: "Mother" },
      { playerId: SUBJECT_IDS.blue, email: email("bulk-y"), relationship: "Mother" },
      { playerId: SUBJECT_IDS.childA, email: "not-an-email", relationship: "Mother" },
      { playerId: SUBJECT_IDS.childA, email: mum, relationship: "Mother" },
    ],
  });
  assert.equal(r.status, 200, r.text);
  const out = r.json as { created: number; rows: { ok: boolean; error?: string; link?: string }[] };
  assert.deepEqual(out.rows.map((x) => x.ok), [true, true, true, false, false, false, false]);
  assert.equal(out.created, 3);
  assert.match(out.rows[3].error ?? "", /No player/);
  assert.match(out.rows[4].error ?? "", /No player/, "another academy's player is not found");
  assert.match(out.rows[5].error ?? "", /valid e-mail/);
  assert.match(out.rows[6].error ?? "", /already an open invitation/, "a second open invitation for the same parent and child is refused");
  // the parent opens both links with ONE account and ends linked to both children
  const { client } = await registered(mum);
  for (const x of out.rows.slice(0, 2)) {
    const token = x.link!.split("#")[1];
    assert.equal((await accept(client, token)).status, 200);
  }
  const [person] = await db().select().from(t.user).where(eq(t.user.email, mum));
  assert.equal((await db().select().from(t.guardianLinks).where(eq(t.guardianLinks.userId, person.id))).length, 2);
  const coach = await existing([{ academyId: "green", role: "COACH" }]);
  assert.equal((await coach.client.post(`${API}/invitations/bulk`, { rows: [{ playerId: SUBJECT_IDS.childA, email: email("c"), relationship: "Mother" }] })).status, 403);
});

test("accept page: the WhatsApp number and a channel-specific opt-in are saved with joining; ticking the box without a number joins nobody", async () => {
  const o = await asOwner();
  const address = email("optin");
  const inv = await made(o, guardianInvite(address, SUBJECT_IDS.childA));
  const { client } = await registered(address);
  const [person] = await db().select().from(t.user).where(eq(t.user.email, address));
  const noNumber = await client.post(ACCEPT, { token: inv.token, whatsappOptIn: true });
  assert.equal(noNumber.status, 422, noNumber.text);
  assert.equal(await memberOf(person.id, "green"), undefined, "nothing was joined");
  assert.equal((await row(inv.id)).status, "PENDING");
  const ok = await client.post(ACCEPT, { token: inv.token, phone: "98765 43210", whatsappOptIn: true });
  assert.equal(ok.status, 200, ok.text);
  const [c] = await db().select().from(t.contactPoints).where(eq(t.contactPoints.userId, person.id));
  assert.deepEqual([c.channel, c.address, c.optInSource, c.optInRevokedAt], ["WHATSAPP", "+919876543210", "INVITATION_ACCEPT", null]);
  assert.ok(c.optedInAt);
  // joining without ticking records no opt-in at all
  const plain = email("no-optin");
  const inv2 = await made(o, guardianInvite(plain, SUBJECT_IDS.childB));
  const second = await registered(plain);
  assert.equal((await second.client.post(ACCEPT, { token: inv2.token, phone: "+919800000000" })).status, 200);
  const [p2] = await db().select().from(t.user).where(eq(t.user.email, plain));
  assert.equal((await db().select().from(t.contactPoints).where(eq(t.contactPoints.userId, p2.id))).length, 0, "no opt-in unless asked");
  assert.equal(p2.phone, "+919800000000");
});

test("SHARED contacts: two separate parent accounts with the same phone stay two accounts with two roles; nothing merges", async () => {
  const o = await asOwner();
  const [a, b] = [email("share-a"), email("share-b")];
  const ia = await made(o, guardianInvite(a, SUBJECT_IDS.childA, "Mother"));
  const ib = await made(o, guardianInvite(b, SUBJECT_IDS.childA, "Father"));
  const [ca, cb] = [await registered(a), await registered(b)];
  assert.equal((await ca.client.post(ACCEPT, { token: ia.token, phone: "+919811112222", whatsappOptIn: true })).status, 200);
  assert.equal((await cb.client.post(ACCEPT, { token: ib.token, phone: "+919811112222", whatsappOptIn: true })).status, 200);
  const users = await db().select().from(t.user).where(eq(t.user.phone, "+919811112222"));
  assert.equal(users.length, 2, "two accounts share one number");
  assert.deepEqual(users.map((u) => u.email).sort(), [a, b].sort());
  for (const u of users) assert.equal((await memberOf(u.id, "green")).role, "GUARDIAN");
  const links = await db().select().from(t.guardianLinks).where(eq(t.guardianLinks.playerId, SUBJECT_IDS.childA));
  assert.ok(users.every((u) => links.some((l) => l.userId === u.id)), "each is linked to the child on their own");
  const points = await db().select().from(t.contactPoints).where(eq(t.contactPoints.address, "+919811112222"));
  assert.equal(points.length, 2, "one opt-in record per account: the same value on two subjects");
});
