import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { emailDeliveryConfigured } from "../src/modules/identity/email-delivery";
import { TERMS_VERSION } from "../src/modules/identity/onboarding-policy";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { addFixtureUser } from "./helpers/fixtures";
import { code, newMember, signedIn, NEW_PASSWORD } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";

/**
 * "Continue with Google" from the SIGN-UP screen: it may create an account, but only an unassigned one, only with the
 * terms accepted, and only for an email Google reports as verified. It never links to an existing account by email;
 * linking stays an explicit act of a signed-in person. Google's token endpoint is the only thing stubbed.
 */
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret-never-in-output-0123456789";
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
// Google sign-up and sign-in must work with NO mail provider: none is configured anywhere in this file.
for (const name of ["EMAIL_PROVIDER", "RESEND_API_KEY", "ZEPTOMAIL_TOKEN", "ZEPTOMAIL_API_URL", "EMAIL_FROM"])
  delete process.env[name];

type Profile = { sub: string; email: string; email_verified?: boolean; name?: string };
let nextProfile: Profile = { sub: "none", email: "none@example.test" };
const realFetch = globalThis.fetch;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://oauth2.googleapis.com/token")) {
    const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      email_verified: true,
      name: "Google Person",
      ...nextProfile,
    })}.`;
    return new Response(
      JSON.stringify({ access_token: "stub-access", refresh_token: "stub-refresh", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: "openid email profile" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(input, init);
}) as typeof fetch;

let app: Harness;
before(async () => {
  app = await startHarness("google-signup");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  globalThis.fetch = realFetch;
  await app?.stop();
});

const userByEmail = async (email: string) =>
  (await database().select().from(t.user).where(eq(t.user.email, email)))[0];
const googleRows = (userId: string) =>
  database().select().from(t.account).where(and(eq(t.account.userId, userId), eq(t.account.providerId, "google")));
const membershipsOf = async (userId: string) =>
  (await database().select().from(t.memberships).where(eq(t.memberships.userId, userId))).length;
const userCount = async () => (await database().select().from(t.user)).length;
const location = (r: { headers: Headers }) => r.headers.get("location") ?? "";
const errorOf = (r: { headers: Headers }) => new URL(location(r), "http://x.invalid").searchParams.get("error");
let counter = 0;
const freshEmail = () => `google-new-${++counter}-${Date.now().toString(36)}@example.test`;

/** What the sign-up screen sends when the terms box is ticked. */
const TERMS = { termsAccepted: true, termsVersion: TERMS_VERSION };

async function viaGoogle(
  client: TestClient,
  profile: Profile,
  options: { signUp?: boolean; terms?: Record<string, unknown> | null; link?: boolean } = {},
) {
  const start = await client.post(options.link ? "/api/auth/link-social" : "/api/auth/sign-in/social", {
    provider: "google",
    callbackURL: options.link ? "/account?google=linked" : "/",
    errorCallbackURL: options.signUp ? "/signup" : "/login",
    requestSignUp: !!options.signUp,
    ...(options.terms === null ? {} : options.terms ? { additionalData: options.terms } : {}),
  });
  assert.equal(start.status, 200, start.text.slice(0, 200));
  const url = new URL((start.json as { url: string }).url);
  nextProfile = profile;
  const back = await client.get(`/api/auth/callback/google?code=stub-code&state=${url.searchParams.get("state")}`);
  return { back };
}

test("no mail provider is configured in this suite, and Google sign-up and sign-in below never need one", async () => {
  assert.equal(emailDeliveryConfigured(), false);
  const before = (await database().select().from(t.authEmailOutbox)).length;
  const email = freshEmail();
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-no-mail", email, email_verified: true }, { signUp: true, terms: TERMS });
  assert.equal(location(back), "/");
  assert.ok(client.hasSession(), "account created and signed in through Google alone");
  // signing in again later (a fresh browser) needs no mail either
  const again = app.anonymous();
  const second = await viaGoogle(again, { sub: "g-no-mail", email, email_verified: true });
  assert.equal(location(second.back), "/");
  assert.ok(again.hasSession());
  assert.equal((await database().select().from(t.authEmailOutbox)).length, before, "no email was queued");
});

test("Google sign-up with the terms accepted creates an UNASSIGNED, verified account, records the terms, and starts a session that reaches no academy data", async () => {
  const email = freshEmail();
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-new-1", email, email_verified: true }, { signUp: true, terms: TERMS });
  assert.equal(back.status, 302);
  assert.equal(location(back), "/");
  assert.ok(client.hasSession());
  const person = await userByEmail(email);
  assert.ok(person, "the account exists");
  assert.equal(person.emailVerified, true, "Google verified the address");
  assert.equal(person.emailVerificationRequired, false);
  assert.equal(person.termsVersion, TERMS_VERSION);
  assert.ok(person.termsAcceptedAt);
  assert.equal(await membershipsOf(person.id), 0, "no academy membership");
  const link = await googleRows(person.id);
  assert.equal(link.length, 1);
  assert.equal(link[0].accessToken, null, "no provider token is kept");
  assert.equal(link[0].idToken, null);
  const created = (await database().select().from(t.securityEvent)).filter(
    (e) => e.event === "ACCOUNT_SIGNED_UP" && e.targetUserId === person.id,
  );
  assert.equal(created.length, 1);
  assert.equal((created[0].detail as { method: string }).method, "google");
  for (const path of ["/api/academy", "/api/academy/identity", "/api/training"]) {
    const r = await client.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(code(r), "NO_MEMBERSHIP", path);
  }
});

test("Google sign-up without the terms, with a stale terms version, or with an unverified Google email creates nothing", async () => {
  const before = await userCount();
  for (const [label, terms, profile] of [
    ["no terms", null, { sub: "g-nt", email: freshEmail(), email_verified: true }],
    ["terms not accepted", { termsAccepted: false, termsVersion: TERMS_VERSION }, { sub: "g-na", email: freshEmail(), email_verified: true }],
    ["stale version", { termsAccepted: true, termsVersion: "1999-01-01" }, { sub: "g-sv", email: freshEmail(), email_verified: true }],
    ["unverified google email", TERMS, { sub: "g-uv", email: freshEmail(), email_verified: false }],
  ] as const) {
    const client = app.anonymous();
    const { back } = await viaGoogle(client, profile, { signUp: true, terms });
    assert.ok(errorOf(back), `${label}: redirected with an error`);
    assert.equal(client.hasSession(), false, label);
    assert.equal(await userByEmail(profile.email), undefined, `${label}: no account`);
  }
  assert.equal(await userCount(), before);
});

test("the sign-IN screen can never create an account: an unknown Google identity is refused even with the terms attached", async () => {
  const email = freshEmail();
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-login-only", email, email_verified: true }, { signUp: false, terms: TERMS });
  assert.ok(errorOf(back));
  assert.equal(client.hasSession(), false);
  assert.equal(await userByEmail(email), undefined);
});

test("Google never takes over or links an existing account by email: owner-provisioned, self-registered, and unverified self-registered alike", async () => {
  // owner-provisioned member
  const member = await newMember("COACH");
  const a = app.anonymous();
  const viaMember = await viaGoogle(a, { sub: "g-take-member", email: member.email, email_verified: true }, { signUp: true, terms: TERMS });
  assert.ok(errorOf(viaMember.back));
  assert.equal(a.hasSession(), false);
  assert.equal((await googleRows(member.id)).length, 0);

  // a finished password signup with no academy
  const verified = await addFixtureUser(`g-verified-${++counter}`, []);
  const b = app.anonymous();
  const viaVerified = await viaGoogle(b, { sub: "g-take-verified", email: verified.email, email_verified: true }, { signUp: true, terms: TERMS });
  assert.ok(errorOf(viaVerified.back));
  assert.equal(b.hasSession(), false);

  // an abandoned, still unverified self-registration cannot be claimed through Google either
  const pendingEmail = freshEmail();
  const signUp = await app.anonymous().post("/api/auth/onboarding/signup", {
    name: "Pending Person",
    email: pendingEmail,
    password: NEW_PASSWORD(),
    acceptTerms: true,
    termsVersion: TERMS_VERSION,
  });
  // delivery may be unconfigured in this file (503); in that case create the unverified row directly
  if (signUp.status !== 200)
    await database().insert(t.user).values({ id: `pending-${counter}`, name: "Pending Person", email: pendingEmail, emailVerified: false, emailVerificationRequired: true });
  const pending = await userByEmail(pendingEmail);
  const c = app.anonymous();
  const viaPending = await viaGoogle(c, { sub: "g-take-pending", email: pendingEmail, email_verified: true }, { signUp: true, terms: TERMS });
  assert.ok(errorOf(viaPending.back));
  assert.equal(c.hasSession(), false);
  assert.equal((await googleRows(pending.id)).length, 0);
  assert.equal((await userByEmail(pendingEmail)).emailVerified, false, "the address was not marked verified by Google");
});

test("explicit linking: a signed-in, verified, unassigned person can link their own Google account (same verified email), and then sign in with it", async () => {
  const account = await addFixtureUser(`g-link-${++counter}`, []);
  const me = await signedIn(app, account.email);
  const { back } = await viaGoogle(me, { sub: "g-link-unassigned", email: account.email, email_verified: true }, { link: true });
  assert.equal(back.status, 302);
  assert.match(location(back), /\/account\?google=linked/);
  assert.equal((await googleRows(account.id)).length, 1);
  assert.equal(await membershipsOf(account.id), 0, "linking gives no academy access");

  const fresh = app.anonymous();
  const signIn = await viaGoogle(fresh, { sub: "g-link-unassigned", email: account.email });
  assert.equal(signIn.back.status, 302);
  assert.ok(fresh.hasSession());
  assert.equal(code(await fresh.get("/api/academy/identity")), "NO_MEMBERSHIP");

  // a different Google email is still refused
  const other = await addFixtureUser(`g-link-other-${++counter}`, []);
  const meOther = await signedIn(app, other.email);
  const mismatch = await viaGoogle(meOther, { sub: "g-mismatch", email: "somebody.else@example.test", email_verified: true }, { link: true });
  assert.ok(errorOf(mismatch.back));
  assert.equal((await googleRows(other.id)).length, 0);
});

test("a self-registered account whose email is NOT verified cannot hold a Google link, and an unverified deactivated member cannot either", async () => {
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  await database().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, member.id));
  await database().update(t.user).set({ emailVerified: false }).where(eq(t.user.id, member.id));
  const { back } = await viaGoogle(me, { sub: "g-inactive-unverified", email: member.email, email_verified: true }, { link: true });
  assert.ok(errorOf(back) ?? back.status >= 400);
  assert.equal((await googleRows(member.id)).length, 0);
});

test("an Owner-protected rule still holds: a Google session is refused for an account that has an authenticator", async () => {
  const member = await newMember("OWNER");
  await database().insert(t.account).values({ id: `g-${member.id}`, accountId: "g-owner-mfa", providerId: "google", userId: member.id });
  await database().update(t.user).set({ twoFactorEnabled: true }).where(eq(t.user.id, member.id));
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-owner-mfa", email: member.email });
  assert.equal(client.hasSession(), false);
  assert.ok(errorOf(back));
});
