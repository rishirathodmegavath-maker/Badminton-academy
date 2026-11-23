import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { emailDeliveryConfigured } from "../src/modules/identity/email-delivery";
import { SIGNUP_CREATED_RESPONSE, TERMS_VERSION } from "../src/modules/identity/onboarding-policy";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, newMember, signedIn, NEW_PASSWORD } from "./helpers/accounts";
import { FIXTURE_PASSWORD } from "./helpers/fixtures";
import { TF, enroll, startChallenge, twoFactorRedirect } from "./helpers/mfa";

/**
 * Sign-in and sign-up must not depend on a mail provider. Only password recovery (and the optional verification
 * code step) needs one. This suite runs the real HTTP stack with NO email provider configured and fails if the
 * application so much as tries to reach a mail API.
 */
for (const name of ["EMAIL_PROVIDER", "RESEND_API_KEY", "ZEPTOMAIL_TOKEN", "ZEPTOMAIL_API_URL", "EMAIL_FROM"])
  delete process.env[name];

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
before(async () => {
  app = await startHarness("auth-without-email");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  globalThis.fetch = realFetch;
  await app?.stop();
});

const SIGNUP = "/api/auth/onboarding/signup";
let counter = 0;
const freshEmail = () => `no-mail-${++counter}-${Date.now().toString(36)}@example.test`;
const db = () => database();
const userByEmail = async (email: string) => (await db().select().from(t.user).where(eq(t.user.email, email)))[0];
const hashOf = async (userId: string) =>
  (await db().select().from(t.account).where(and(eq(t.account.userId, userId), eq(t.account.providerId, "credential"))))[0]?.password;
const memberships = async (userId: string) =>
  (await db().select().from(t.memberships).where(eq(t.memberships.userId, userId))).length;

async function signUp(over: Partial<{ email: string; password: string; name: string; acceptTerms: boolean; termsVersion: string }> = {}) {
  const body = {
    name: "Priya Mehta",
    email: freshEmail(),
    password: NEW_PASSWORD(),
    acceptTerms: true,
    termsVersion: TERMS_VERSION,
    ...over,
  };
  const client = app.anonymous();
  return { client, body, response: await client.post(SIGNUP, body) };
}

test("the suite really has no email provider configured", () => {
  assert.equal(emailDeliveryConfigured(), false);
});

test("LOGIN without an email provider: an existing account signs in, uses the application, and signs out", async () => {
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  assert.equal((await me.get("/api/academy/identity")).status, 200);
  assert.equal(((await me.get("/api/auth/account/security-state")).json as { gate: unknown }).gate, null);
  assert.equal((await me.signOut()).status, 200);
  assert.equal((await me.get("/api/academy/identity")).status, 401);
  // a wrong password is still an ordinary refusal
  assert.equal(code(await app.anonymous().signIn(member.email, "Definitely-Wrong-Password-1")), "INVALID_EMAIL_OR_PASSWORD");
});

test("LOGIN keeps the second factor: an account with an authenticator still stops at the code step", async () => {
  const member = await newMember("COACH");
  const enrolled = await enroll(app, member);
  const { client, step1 } = await startChallenge(app, member.email);
  assert.ok(twoFactorRedirect(step1), "password alone does not sign in");
  assert.equal(client.hasSession(), false);
  const done = await client.post(`${TF}/verify-totp`, { code: enrolled.code() });
  assert.equal(done.status, 200, done.text);
  assert.ok(client.hasSession());
});

test("SIGNUP without an email provider: the account exists at once, unverified and unassigned, with no email or code involved", async () => {
  const { client, body, response } = await signUp();
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, SIGNUP_CREATED_RESPONSE);
  assert.equal(client.hasSession(), false, "signup itself starts no session");

  const person = await userByEmail(body.email);
  assert.equal(person.emailVerified, false, "marked UNVERIFIED");
  assert.equal(person.emailVerificationRequired, false, "nothing blocks the first sign-in");
  assert.equal(person.termsVersion, TERMS_VERSION);
  assert.ok(person.termsAcceptedAt);
  assert.equal(await memberships(person.id), 0, "no academy membership");
  const hash = await hashOf(person.id);
  assert.ok(hash && !hash.includes(body.password), "stored only as a hash");
  assert.equal((await db().select().from(t.authEmailOutbox)).length, 0, "no email was queued");
  assert.equal((await db().select().from(t.verification)).length, 0, "no code was issued");
  const events = (await db().select().from(t.securityEvent)).filter((e) => e.targetUserId === person.id && e.event === "ACCOUNT_SIGNED_UP");
  assert.equal(events.length, 1);
  assert.equal((events[0].detail as { emailVerified: boolean }).emailVerified, false);

  // The person signs in with the password just chosen, still without any email, and reaches no academy data.
  const me = await signedIn(app, body.email, body.password);
  for (const path of ["/api/academy", "/api/academy/identity", "/api/training"]) {
    const r = await me.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(code(r), "NO_MEMBERSHIP", path);
  }
  assert.equal(await memberships(person.id), 0);
  assert.equal((await userByEmail(body.email)).emailVerified, false, "signing in does not verify the address");
});

test("SIGNUP input is validated exactly as before: terms, terms version, weak password, malformed fields", async () => {
  const noTerms = await signUp({ acceptTerms: false });
  assert.equal(code(noTerms.response), "TERMS_REQUIRED");
  assert.equal(await userByEmail(noTerms.body.email), undefined);
  const stale = await signUp({ termsVersion: "1999-01-01" });
  assert.equal(code(stale.response), "TERMS_VERSION_CHANGED");
  assert.equal(await userByEmail(stale.body.email), undefined);
  const weak = await signUp({ password: "password1234" });
  assert.equal(code(weak.response), "WEAK_PASSWORD");
  assert.equal(await userByEmail(weak.body.email), undefined);
  for (const bad of [{ email: "not-an-email" }, { name: "x" }, { password: "x".repeat(129) }])
    assert.equal((await signUp(bad)).response.status, 400);
});

test("SIGNUP never touches an address that already has an account (409), whoever owns it", async () => {
  const mine = await signUp();
  const person = await userByEmail(mine.body.email);
  const before = { hash: await hashOf(person.id), name: person.name, terms: person.termsAcceptedAt?.getTime() };

  const attempts = [
    { who: "self-registered", email: mine.body.email, id: person.id },
    { who: "owner-provisioned", ...(await newMember("COACH")) },
  ];
  for (const target of attempts) {
    const hashBefore = await hashOf(target.id);
    const r = await signUp({ email: target.email, password: NEW_PASSWORD(), name: "Attacker Name" });
    assert.equal(r.response.status, 409, target.who);
    assert.equal(code(r.response), "EMAIL_IN_USE", target.who);
    assert.equal(await hashOf(target.id), hashBefore, `${target.who}: password unchanged`);
    assert.notEqual((await userByEmail(target.email)).name, "Attacker Name", `${target.who}: name unchanged`);
    assert.equal(r.client.hasSession(), false);
  }
  // the original owner of the self-registered account still gets in with their own password, not the attacker's
  assert.ok(await signedIn(app, mine.body.email, mine.body.password));
  const after = await userByEmail(mine.body.email);
  assert.equal(await hashOf(person.id), before.hash);
  assert.equal(after.name, before.name);
  assert.equal(after.termsAcceptedAt?.getTime(), before.terms);
  assert.equal(after.emailVerified, false);
});

test("SIGNUP is rate limited per address: the sixth attempt in a window is refused", async () => {
  const email = freshEmail();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signUp({ email })).response.status);
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 429]);
});

test("PASSWORD RECOVERY is the one thing that needs email, and it says so: unavailable without a provider, nothing queued", async () => {
  const methods = await app.anonymous().get("/api/auth/account/sign-in-methods");
  const json = methods.json as { signup: Record<string, unknown>; passwordReset: { enabled: boolean } };
  assert.equal(json.passwordReset.enabled, false, "the forgot-password screen is told email is off");
  assert.equal("enabled" in json.signup, false, "signup is never reported as disabled");
  assert.equal(json.signup.termsVersion, TERMS_VERSION);

  const member = await newMember("COACH");
  const self = await signUp();
  for (const email of [member.email, self.body.email, freshEmail()]) {
    const r = await app.anonymous().post("/api/auth/onboarding/forgot-password", { email });
    assert.equal(r.status, 503, email);
    assert.equal(code(r), "RESET_UNAVAILABLE");
  }
  // a forged reset link is simply refused; the optional verification-code step is the other email feature
  const forged = await app.anonymous().post("/api/auth/onboarding/reset-password", {
    token: "00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    password: NEW_PASSWORD(),
  });
  assert.equal(code(forged), "INVALID_RESET_TOKEN");
  assert.equal((await app.anonymous().post("/api/auth/onboarding/resend-verification", { email: self.body.email })).status, 503);
  assert.ok(await signedIn(app, member.email, FIXTURE_PASSWORD), "passwords were not changed by any of this");
});

test("nothing in this suite tried to reach a mail provider or queued an email", async () => {
  assert.deepEqual(mailCalls, []);
  assert.equal((await db().select().from(t.authEmailOutbox)).length, 0);
});
