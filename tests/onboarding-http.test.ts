import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  deliverAuthEmailOnce,
  settleAuthEmailDelivery,
} from "../src/modules/identity/email-delivery";
import {
  GENERIC_RESET_RESPONSE,
  GENERIC_SIGNUP_RESPONSE,
  SIGNUP_CREATED_RESPONSE,
  TERMS_VERSION,
} from "../src/modules/identity/onboarding-policy";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { addFixtureUser, FIXTURE_PASSWORD } from "./helpers/fixtures";
import { code, newMember, pendingVerificationAccount, signedIn, NEW_PASSWORD } from "./helpers/accounts";
import { enroll, twoFactorRedirect } from "./helpers/mfa";
import type { TestClient } from "./helpers/client";

/**
 * Public onboarding (signup, email verification, resend, forgot/reset password), end to end over real HTTP.
 * Only Resend's HTTP endpoint is stubbed (it records what would have been emailed), so the outbox, the
 * dispatcher, the sealing of secrets, the throttles, the account gate and the audit log are the real ones.
 */
process.env.EMAIL_PROVIDER = "resend";
process.env.RESEND_API_KEY = "re_test_key_never_echoed_0123456789";
process.env.EMAIL_FROM = "Sportozen <no-reply@example.test>";

type Mail = { to: string; subject: string; text: string; html?: string; key: string };
const mails: Mail[] = [];
let resendStatus = 200;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.resend.com/emails")) {
    if (resendStatus !== 200) return new Response("{}", { status: resendStatus });
    const body = JSON.parse(String(init?.body));
    mails.push({
      to: body.to[0],
      subject: body.subject,
      text: body.text,
      html: body.html,
      key: String((init?.headers as Record<string, string>)["Idempotency-Key"]),
    });
    return new Response(JSON.stringify({ id: `msg_${mails.length}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

let app: Harness;
let secret = "";
before(
  async () => {
    app = await startHarness("onboarding-http");
    secret = process.env.BETTER_AUTH_SECRET!;
  },
  { timeout: HOOK_TIMEOUT },
);
after(async () => {
  globalThis.fetch = realFetch;
  await app?.stop();
});

const SIGNUP = "/api/auth/onboarding/signup";
const VERIFY = "/api/auth/onboarding/verify-email";
const RESEND = "/api/auth/onboarding/resend-verification";
const FORGOT = "/api/auth/onboarding/forgot-password";
const RESET = "/api/auth/onboarding/reset-password";
/** What the verification screen sends: the emailed code AND the password the person wants, typed twice. */
const verifyBody = (email: string, code: string, password: string, confirmPassword = password) => ({
  email,
  code,
  password,
  confirmPassword,
});
let counter = 0;
const freshEmail = () => `onboard-${++counter}-${Date.now().toString(36)}@example.test`;
const db = () => database();
const userByEmail = async (email: string) =>
  (await db().select().from(t.user).where(eq(t.user.email, email)))[0];
const membershipsOf = async (userId: string) =>
  (await db().select().from(t.memberships).where(eq(t.memberships.userId, userId))).length;
const sessionsOf = async (userId: string) =>
  (await db().select().from(t.session).where(eq(t.session.userId, userId))).length;
const eventsOf = async (userId: string, event: string) =>
  (await db().select().from(t.securityEvent).where(eq(t.securityEvent.targetUserId, userId))).filter(
    (e) => e.event === event,
  );
const outboxOf = (userId: string) =>
  db().select().from(t.authEmailOutbox).where(eq(t.authEmailOutbox.userId, userId)).orderBy(desc(t.authEmailOutbox.createdAt));
const verificationRows = (identifier: string) =>
  db().select().from(t.verification).where(eq(t.verification.identifier, identifier));
const credentialHash = async (userId: string) =>
  (
    await db()
      .select()
      .from(t.account)
      .where(and(eq(t.account.userId, userId), eq(t.account.providerId, "credential")))
  )[0]?.password;

/** Everything the stub received for this address, after the dispatcher has finished. */
async function mailTo(email: string) {
  await settleAuthEmailDelivery();
  return mails.filter((m) => m.to === email);
}
const codeIn = (mail: Mail) => /code is (\d{6})/.exec(mail.text)![1];
const tokenIn = (mail: Mail) => {
  const link = /(https?:\/\/\S+)/.exec(mail.text)![1];
  return { link, token: decodeURIComponent(link.split("#token=")[1]) };
};
/** Pretend `ms` have passed since the last email of this kind: the cooldown is measured from its row. */
async function ageOutbox(userId: string, ms = 120_000) {
  const past = new Date(Date.now() - ms);
  await db().update(t.authEmailOutbox).set({ createdAt: past }).where(eq(t.authEmailOutbox.userId, userId));
}

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
  const response = await client.post(SIGNUP, body);
  return { client, body, response };
}

/** An account waiting for an emailed code (the optional step; password signup itself needs no email). */
const pendingAccount = (over: Parameters<typeof pendingVerificationAccount>[1] = {}) =>
  pendingVerificationAccount(app, over);

/** A verified, password-holding account with no academy and no mail involved. */
async function verifiedSignup() {
  const id = `verified-${++counter}-${Date.now().toString(36)}`;
  const account = await addFixtureUser(id, []);
  return { email: account.email, password: FIXTURE_PASSWORD, id };
}

test("even with a mail provider configured, password signup sends no email, issues no code and needs none: the account is unverified, unassigned, and signs in at once", async () => {
  const outboxBefore = (await db().select().from(t.authEmailOutbox)).length;
  const { client, body, response } = await signUp();
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.json, SIGNUP_CREATED_RESPONSE);
  assert.equal(client.hasSession(), false, "signup itself starts no session");
  const person = await userByEmail(body.email);
  assert.equal(person.emailVerified, false, "marked unverified");
  assert.equal(person.emailVerificationRequired, false);
  assert.equal(person.termsVersion, TERMS_VERSION);
  assert.equal(await membershipsOf(person.id), 0, "no academy membership");
  assert.equal((await db().select().from(t.authEmailOutbox)).length, outboxBefore, "no email queued");
  assert.equal((await verificationRows(`email-otp:${body.email}`)).length, 0, "no code issued");
  assert.equal((await mailTo(body.email)).length, 0, "no email sent");
  assert.ok(await signedIn(app, body.email, body.password));
  // and being unverified keeps it out of email recovery: no reset link is ever sent to it
  await app.anonymous().post(FORGOT, { email: body.email });
  assert.equal((await mailTo(body.email)).length, 0);
});

test("signup input is validated: terms, terms version, weak password, malformed email, oversize fields", async () => {
  const noTerms = await signUp({ acceptTerms: false });
  assert.equal(noTerms.response.status, 400);
  assert.equal(code(noTerms.response), "TERMS_REQUIRED");
  assert.equal(await userByEmail(noTerms.body.email), undefined, "nothing was created");

  const stale = await signUp({ termsVersion: "1999-01-01" });
  assert.equal(stale.response.status, 409);
  assert.equal(code(stale.response), "TERMS_VERSION_CHANGED");
  assert.equal(await userByEmail(stale.body.email), undefined);

  const weak = await signUp({ password: "password1234" });
  assert.equal(weak.response.status, 400);
  assert.equal(code(weak.response), "WEAK_PASSWORD");
  assert.equal(await userByEmail(weak.body.email), undefined);

  for (const bad of [{ email: "not-an-email" }, { name: "x" }, { name: "n".repeat(101) }, { password: "x".repeat(129) }]) {
    const r = await signUp(bad);
    assert.equal(r.response.status, 400, JSON.stringify(Object.keys(bad)));
  }
});

test("a provider outage does not lose the account or the email: it stays queued, sealed, and is sent later", async () => {
  resendStatus = 503;
  try {
    const { response, body } = await pendingAccount();
    assert.equal(response.status, 200, "signup does not depend on the provider being up");
    await settleAuthEmailDelivery();
    const person = await userByEmail(body.email);
    const [row] = await outboxOf(person.id);
    assert.equal(row.status, "FAILED_RETRYABLE");
    assert.ok(row.sealedPayload, "still queued");
    assert.ok(!row.sealedPayload!.includes(body.email) && !/\d{6}/.test(row.sealedPayload!), "sealed: no address or code in the clear");
    assert.equal((await mailTo(body.email)).length, 0);
    resendStatus = 200;
    await db().update(t.authEmailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(t.authEmailOutbox.id, row.id));
    const summary = await deliverAuthEmailOnce(secret);
    assert.equal(summary?.sent, 1);
    assert.equal((await mailTo(body.email)).length, 1, "the worker delivered it");
  } finally {
    resendStatus = 200;
  }
});

test("verification: wrong code refused, right code verifies once, no session is created, and the person then signs in unassigned", async () => {
  const { body } = await pendingAccount();
  const [mail] = await mailTo(body.email);
  const otp = codeIn(mail);
  const wrong = otp === "000000" ? "111111" : "000000";
  const bad = await app.anonymous().post(VERIFY, verifyBody(body.email, wrong, body.password));
  assert.equal(bad.status, 400);
  assert.equal(code(bad), "INVALID_CODE");
  assert.equal((await userByEmail(body.email)).emailVerified, false);

  const client = app.anonymous();
  const ok = await client.post(VERIFY, verifyBody(body.email, otp, body.password));
  assert.equal(ok.status, 200, ok.text);
  assert.equal(client.hasSession(), false, "verification does not sign anyone in");
  const person = await userByEmail(body.email);
  assert.equal(person.emailVerified, true);
  assert.equal(await sessionsOf(person.id), 0);
  assert.equal((await verificationRows(`email-otp:${body.email}`)).length, 0, "the code is spent");
  assert.equal((await eventsOf(person.id, "EMAIL_VERIFIED")).length, 1);
  const replay = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, body.password));
  assert.equal(code(replay), "INVALID_CODE", "a code works once");

  // signing in now works, and the account is still unassigned: the application says so and shows nothing
  const me = await signedIn(app, body.email, body.password);
  assert.equal(await membershipsOf(person.id), 0);
  const identity = await me.get("/api/academy/identity");
  assert.equal(identity.status, 403);
  assert.equal(code(identity), "NO_MEMBERSHIP");
});

test("verification is unavailable for unknown addresses in exactly the same way, and expired codes are refused", async () => {
  const unknown = await app.anonymous().post(VERIFY, verifyBody(freshEmail(), "123456", NEW_PASSWORD()));
  assert.equal(unknown.status, 400);
  assert.equal(code(unknown), "INVALID_CODE");
  const { body } = await pendingAccount();
  const otp = codeIn((await mailTo(body.email))[0]);
  await db()
    .update(t.verification)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(t.verification.identifier, `email-otp:${body.email}`));
  const expired = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, body.password));
  assert.equal(code(expired), "INVALID_CODE");
  assert.equal((await userByEmail(body.email)).emailVerified, false);
  // a malformed code never reaches the lookup
  assert.equal((await app.anonymous().post(VERIFY, verifyBody(body.email, "12ab56", body.password))).status, 400);
});

test("guessing is bounded: five wrong codes withdraw the code, and even the right one is then refused", async () => {
  const { body } = await pendingAccount();
  const otp = codeIn((await mailTo(body.email))[0]);
  const wrong = otp === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    const r = await app.anonymous().post(VERIFY, verifyBody(body.email, wrong, body.password));
    assert.equal(r.status, 400, `guess ${i + 1}`);
  }
  assert.equal((await verificationRows(`email-otp:${body.email}`)).length, 0, "the fifth failure withdrew the code");
  const locked = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, body.password));
  assert.equal(locked.status, 429);
  assert.equal(code(locked), "TOO_MANY_ATTEMPTS");
  assert.equal((await userByEmail(body.email)).emailVerified, false);
  // parallel guesses cannot beat the cap: at most five are ever evaluated
  const fresh = await pendingAccount();
  const freshOtp = codeIn((await mailTo(fresh.body.email))[0]);
  const bogus = freshOtp === "000000" ? "111111" : "000000";
  const burst = await Promise.all(Array.from({ length: 12 }, () => app.anonymous().post(VERIFY, verifyBody(fresh.body.email, bogus, fresh.body.password))));
  assert.equal(burst.filter((r) => r.status === 400).length, 5);
  assert.equal(burst.filter((r) => r.status === 429).length, 7);
});

test("the email address must be verified before any session: password sign-in is refused with a stable code", async () => {
  const { body } = await pendingAccount();
  const client = app.anonymous();
  const refused = await client.signIn(body.email, body.password);
  assert.equal(refused.status, 403);
  assert.equal(code(refused), "EMAIL_NOT_VERIFIED");
  assert.equal(client.hasSession(), false);
  const person = await userByEmail(body.email);
  assert.equal(await sessionsOf(person.id), 0);
  // a wrong password still looks like any wrong password
  const wrongPassword = await app.anonymous().signIn(body.email, "Definitely-Wrong-Password-1");
  assert.equal(code(wrongPassword), "INVALID_EMAIL_OR_PASSWORD");
});

test("resend: a new code replaces the old one, a minute must pass between sends, and nothing reveals whether an address exists", async () => {
  const { body } = await pendingAccount();
  const person = await userByEmail(body.email);
  const first = codeIn((await mailTo(body.email))[0]);

  const early = await app.anonymous().post(RESEND, { email: body.email });
  assert.equal(early.status, 200);
  assert.deepEqual(early.json, GENERIC_SIGNUP_RESPONSE);
  assert.equal((await mailTo(body.email)).length, 1, "inside the cooldown nothing new is sent");

  await ageOutbox(person.id);
  const later = await app.anonymous().post(RESEND, { email: body.email });
  assert.deepEqual(later.json, GENERIC_SIGNUP_RESPONSE);
  const sent = await mailTo(body.email);
  assert.equal(sent.length, 2);
  const second = codeIn(sent[1]);
  assert.equal((await verificationRows(`email-otp:${body.email}`)).length, 1, "only one live code");
  if (second !== first) {
    const old = await app.anonymous().post(VERIFY, verifyBody(body.email, first, body.password));
    assert.equal(code(old), "INVALID_CODE", "the previous code stopped working");
  }
  const ok = await app.anonymous().post(VERIFY, verifyBody(body.email, second, body.password));
  assert.equal(ok.status, 200);

  // unknown, verified and provisioned addresses: same answer, no email, no rows
  const stranger = freshEmail();
  const unknown = await app.anonymous().post(RESEND, { email: stranger });
  assert.deepEqual(unknown.json, GENERIC_SIGNUP_RESPONSE);
  assert.equal((await mailTo(stranger)).length, 0);
  const verified = await app.anonymous().post(RESEND, { email: body.email });
  assert.deepEqual(verified.json, GENERIC_SIGNUP_RESPONSE);
  assert.equal((await mailTo(body.email)).length, 2, "an already verified address gets nothing");
  const member = await newMember("COACH");
  await app.anonymous().post(RESEND, { email: member.email });
  assert.equal((await mailTo(member.email)).length, 0, "an owner-provisioned account is not a signup");
});

/** Names the secret a victim's address would be locked to: nobody. */
const refusedWith = async (email: string, passwords: string[]) => {
  for (const password of passwords) {
    const refused = await app.anonymous().signIn(email, password);
    assert.equal(refused.status, 401, "a locked or wrong password is the ordinary refusal");
    assert.equal(code(refused), "INVALID_EMAIL_OR_PASSWORD");
  }
};

test("verification takes the password with the code: both are required, they must match, a refused password does not spend the code, and a wrong code changes nothing", async () => {
  const { body } = await pendingAccount({ name: "Priya Mehta" });
  const person = await userByEmail(body.email);
  const otp = codeIn((await mailTo(body.email))[0]);
  const stored = await credentialHash(person.id);
  const good = NEW_PASSWORD();
  const stillWaiting = async (why: string) => {
    assert.equal((await userByEmail(body.email)).emailVerified, false, why);
    assert.equal((await verificationRows(`email-otp:${body.email}`)).length, 1, `${why}: the code is not spent`);
    assert.equal(await credentialHash(person.id), stored, `${why}: the stored password is untouched`);
  };

  // missing fields never reach the lookup
  assert.equal((await app.anonymous().post(VERIFY, { email: body.email, code: otp })).status, 400);
  assert.equal((await app.anonymous().post(VERIFY, { email: body.email, code: otp, password: good })).status, 400);
  await stillWaiting("missing password or confirmation");

  // a typing slip in the confirmation
  const mismatch = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, good, `${good}x`));
  assert.equal(mismatch.status, 400);
  assert.equal(code(mismatch), "PASSWORD_MISMATCH");
  await stillWaiting("mismatch");

  // the password policy applies: too short, and one that contains the person's own name
  const short = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, "short1"));
  assert.equal(code(short), "WEAK_PASSWORD");
  await stillWaiting("too short");
  const personal = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, "Priyamehta-Violet-Quartz-88"));
  assert.equal(personal.status, 400);
  assert.equal(code(personal), "WEAK_PASSWORD", "judged against the account's name once the code is right");
  await stillWaiting("contains the name");

  // a wrong code with a perfectly good password changes nothing, and the right code still works afterwards
  const wrong = otp === "000000" ? "111111" : "000000";
  const bad = await app.anonymous().post(VERIFY, verifyBody(body.email, wrong, good));
  assert.equal(code(bad), "INVALID_CODE");
  await stillWaiting("wrong code");

  const ok = await app.anonymous().post(VERIFY, verifyBody(body.email, otp, good));
  assert.equal(ok.status, 200, ok.text);
  assert.ok(await signedIn(app, body.email, good));
  await refusedWith(body.email, [body.password]);
});

test("per-address limits: the sixth signup attempt for one address in a window is refused (a repeat is a 409, the sixth is throttled)", async () => {
  const email = freshEmail();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signUp({ email })).response.status);
  assert.deepEqual(statuses, [200, 409, 409, 409, 409, 429]);
});

test("forgot password: the answer never depends on the account; only a verified, non-owner account is emailed", async () => {
  const verified = await verifiedSignup();
  const unverified = await signUp();
  const owner = await addFixtureUser(`reset-owner-${++counter}`, [{ academyId: "green", role: "OWNER" }]);
  const coach = await newMember("COACH");
  const answers = [];
  for (const email of [freshEmail(), unverified.body.email, owner.email, verified.email, coach.email]) {
    const r = await app.anonymous().post(FORGOT, { email });
    assert.equal(r.status, 200, email);
    answers.push(JSON.stringify(r.json));
  }
  assert.ok(answers.every((a) => a === JSON.stringify(GENERIC_RESET_RESPONSE)), "identical answers");

  assert.equal((await mailTo(owner.email)).length, 0, "owners are never emailed a reset link");
  assert.equal((await mailTo(unverified.body.email)).filter((m) => m.subject.includes("Reset")).length, 0);
  const resetMail = (m: Mail) => m.subject.includes("Reset");
  assert.equal((await mailTo(verified.email)).filter(resetMail).length, 1);
  assert.equal((await mailTo(coach.email)).filter(resetMail).length, 1);
  const ownerId = (await userByEmail(owner.email)).id;
  assert.equal((await eventsOf(ownerId, "PASSWORD_RESET_REFUSED")).length, 1);
  assert.equal((await eventsOf(ownerId, "PASSWORD_RESET_REQUESTED")).length, 0);

  const mail = (await mailTo(verified.email)).find(resetMail)!;
  const { link } = tokenIn(mail);
  assert.ok(link.includes("/reset-password#token="), "the token is in the URL fragment");
  assert.ok(!link.includes("?"), "never in a query string");
  const [outbox] = await outboxOf(verified.id);
  assert.equal(outbox.kind, "PASSWORD_RESET_LINK");
  // a second request inside the cooldown sends nothing new
  await app.anonymous().post(FORGOT, { email: verified.email });
  assert.equal((await mailTo(verified.email)).filter(resetMail).length, 1);
});

test("reset: single-use token sets a new password, ends every session, signs nobody in, and clears a temporary password", async () => {
  const account = await verifiedSignup();
  const old = await signedIn(app, account.email, account.password);
  await db().insert(t.temporaryCredential).values({
    userId: account.id,
    source: "OWNER_RESET",
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  assert.equal(await sessionsOf(account.id), 1);
  await app.anonymous().post(FORGOT, { email: account.email });
  const mail = (await mailTo(account.email)).find((m) => m.subject.includes("Reset"))!;
  const { token } = tokenIn(mail);
  const [row] = await verificationRows(`password-reset:${account.id}`);
  assert.ok(row.value.startsWith("hmac-sha256:v1:") && !row.value.includes(token.split(".")[1]), "the token is stored only as a keyed hash");

  const weak = await app.anonymous().post(RESET, { token, password: "password1234" });
  assert.equal(code(weak), "WEAK_PASSWORD");
  assert.equal((await verificationRows(`password-reset:${account.id}`)).length, 1, "a weak password does not spend the link");

  const newPassword = NEW_PASSWORD();
  const client = app.anonymous();
  const done = await client.post(RESET, { token, password: newPassword });
  assert.equal(done.status, 200, done.text);
  assert.equal(client.hasSession(), false, "resetting does not sign anyone in");
  assert.equal(await sessionsOf(account.id), 0, "every session ended");
  assert.equal((await old.get("/api/academy/identity")).status, 401, "the old cookie is dead");
  assert.equal((await db().select().from(t.temporaryCredential).where(eq(t.temporaryCredential.userId, account.id))).length, 0);
  assert.equal((await eventsOf(account.id, "PASSWORD_RESET_COMPLETED")).length, 1);
  assert.ok(!JSON.stringify(await db().select().from(t.securityEvent)).includes(newPassword));

  assert.equal((await app.anonymous().signIn(account.email, account.password)).status, 401, "the old password is gone");
  assert.ok(await signedIn(app, account.email, newPassword));
  const replay = await app.anonymous().post(RESET, { token, password: NEW_PASSWORD() });
  assert.equal(code(replay), "INVALID_RESET_TOKEN", "the link works once");
});

test("reset: malformed, forged, expired and over-tried tokens are all the same refusal", async () => {
  const account = await verifiedSignup();
  await app.anonymous().post(FORGOT, { email: account.email });
  const mail = (await mailTo(account.email)).find((m) => m.subject.includes("Reset"))!;
  const { token } = tokenIn(mail);
  const [id, part] = token.split(".");
  const password = NEW_PASSWORD();
  for (const bad of ["", "garbage", `${id}.short`, `${id}.${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}`, `00000000-0000-4000-8000-000000000000.${part}`]) {
    const r = await app.anonymous().post(RESET, { token: bad || "x", password });
    assert.equal(code(r), "INVALID_RESET_TOKEN", bad);
  }
  assert.equal(await sessionsOf(account.id), 0);
  // Only the well-formed wrong secret counted against this link (malformed tokens never reach a lookup, and a
  // different id is a different link). Four more wrong guesses make five, which withdraws it.
  assert.equal((await verificationRows(`password-reset:${account.id}`)).length, 1, "still live after one wrong guess");
  for (let i = 0; i < 4; i++)
    await app.anonymous().post(RESET, { token: `${id}.${part.slice(0, -1)}${part.endsWith("A") ? "B" : "A"}`, password });
  assert.equal((await verificationRows(`password-reset:${account.id}`)).length, 0, "five wrong guesses withdrew the link");
  assert.ok([400, 429].includes((await app.anonymous().post(RESET, { token, password })).status));

  // expiry
  await ageOutbox(account.id);
  await app.anonymous().post(FORGOT, { email: account.email });
  const second = tokenIn((await mailTo(account.email)).filter((m) => m.subject.includes("Reset"))[1]).token;
  await db().update(t.verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(t.verification.identifier, `password-reset:${account.id}`));
  assert.equal(code(await app.anonymous().post(RESET, { token: second, password })), "INVALID_RESET_TOKEN");
  assert.ok(await signedIn(app, account.email, account.password), "the password never changed");
});

test("reset for an account with an authenticator also needs a current code: the link alone is not enough, and the authenticator survives", async () => {
  const member = await newMember("COACH");
  const enrolled = await enroll(app, member);
  await app.anonymous().post(FORGOT, { email: member.email });
  const mail = (await mailTo(member.email)).find((m) => m.subject.includes("Reset"))!;
  const { token } = tokenIn(mail);
  const newPassword = NEW_PASSWORD();

  const none = await app.anonymous().post(RESET, { token, password: newPassword });
  assert.equal(none.status, 422);
  assert.equal(code(none), "MFA_CODE_REQUIRED");
  const wrong = await app.anonymous().post(RESET, { token, password: newPassword, mfaCode: "000000" });
  assert.equal(code(wrong), "INVALID_CODE");
  assert.equal((await app.anonymous().signIn(member.email, newPassword)).status, 401, "nothing changed yet");
  assert.equal((await verificationRows(`password-reset:${member.id}`)).length, 1, "a missing or wrong code does not spend the link");

  const good = enrolled.code();
  const done = await app.anonymous().post(RESET, { token, password: newPassword, mfaCode: good });
  assert.equal(done.status, 200, done.text);
  // the same code cannot be replayed to reset again (new link needed anyway), and the factor is still enrolled
  const [person] = await db().select().from(t.user).where(eq(t.user.id, member.id));
  assert.equal(person.twoFactorEnabled, true);
  assert.equal((await db().select().from(t.twoFactor).where(eq(t.twoFactor.userId, member.id))).length, 1);
  // signing in with the new password still stops at the second step: no session without the authenticator
  const step = await app.anonymous().signIn(member.email, newPassword);
  assert.ok(twoFactorRedirect(step), "the second factor is still required");
  assert.equal(await sessionsOf(member.id), 0);
  assert.equal(((await eventsOf(member.id, "PASSWORD_RESET_COMPLETED"))[0].detail as { secondFactor: string }).secondFactor, "totp");
});

test("reset for an account with an authenticator accepts one recovery code, once", async () => {
  const member = await newMember("COACH");
  const enrolled = await enroll(app, member);
  await app.anonymous().post(FORGOT, { email: member.email });
  const { token } = tokenIn((await mailTo(member.email)).find((m) => m.subject.includes("Reset"))!);
  const recovery = enrolled.backupCodes[0];
  const done = await app.anonymous().post(RESET, { token, password: NEW_PASSWORD(), mfaCode: recovery });
  assert.equal(done.status, 200, done.text);
  await ageOutbox(member.id);
  await app.anonymous().post(FORGOT, { email: member.email });
  const next = tokenIn((await mailTo(member.email)).filter((m) => m.subject.includes("Reset"))[1]).token;
  const reused = await app.anonymous().post(RESET, { token: next, password: NEW_PASSWORD(), mfaCode: recovery });
  assert.equal(code(reused), "INVALID_CODE", "a recovery code is spent by use");
});

test("owner protection: a link issued before an account became an owner stops working, and owners cannot reset by email", async () => {
  const member = await newMember("ADMIN");
  await app.anonymous().post(FORGOT, { email: member.email });
  const { token } = tokenIn((await mailTo(member.email)).find((m) => m.subject.includes("Reset"))!);
  await db().update(t.memberships).set({ role: "OWNER" }).where(eq(t.memberships.userId, member.id));
  const before = await credentialHash(member.id);
  const r = await app.anonymous().post(RESET, { token, password: NEW_PASSWORD() });
  assert.equal(code(r), "INVALID_RESET_TOKEN");
  assert.equal(await credentialHash(member.id), before, "the owner's password did not change");
  assert.equal((await verificationRows(`password-reset:${member.id}`)).length, 0, "the link was withdrawn");
  assert.equal((await eventsOf(member.id, "PASSWORD_RESET_REFUSED")).length, 1);
});

test("an owner-provisioned account that has not verified its address cannot be reset by email (the owner issues a temporary password)", async () => {
  const member = await newMember("COACH");
  await db().update(t.user).set({ emailVerified: false }).where(eq(t.user.id, member.id));
  await app.anonymous().post(FORGOT, { email: member.email });
  assert.equal((await mailTo(member.email)).length, 0);
  // and the owner-provisioned sign-in is not blocked by the new verification gate
  assert.ok(await signedIn(app, member.email, FIXTURE_PASSWORD));
});

test("the unassigned self-registered account never gains access by itself: every academy route refuses it", async () => {
  const account = await verifiedSignup();
  const me = await signedIn(app, account.email, account.password);
  for (const path of ["/api/academy", "/api/academy/identity", "/api/training"]) {
    const r = await me.get(path);
    assert.equal(r.status, 403, path);
    assert.equal(code(r), "NO_MEMBERSHIP", path);
  }
  assert.equal(await membershipsOf(account.id), 0);
});
