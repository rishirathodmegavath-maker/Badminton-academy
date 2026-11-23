import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, desc } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { deliverAuthEmailOnce, settleAuthEmailDelivery } from "../src/modules/identity/email-delivery";
import { GENERIC_RESET_RESPONSE, TERMS_VERSION } from "../src/modules/identity/onboarding-policy";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { code, signedIn, NEW_PASSWORD, pendingVerificationAccount } from "./helpers/accounts";

/**
 * Signup OTP, email verification and password recovery delivered through Zoho ZeptoMail, end to end over real HTTP.
 * Only ZeptoMail's HTTPS endpoint is stubbed (it records what would have been emailed): the outbox, the sealing of
 * secrets, the dispatcher/worker path, the throttles, the account gate and the audit log are the real ones.
 * No request leaves this process.
 */
const TOKEN = "wSsVR60z_zeptomail_test_token_never_echoed_0123456789";
process.env.EMAIL_PROVIDER = "zeptomail";
process.env.ZEPTOMAIL_TOKEN = `Zoho-enczapikey ${TOKEN}`;
process.env.ZEPTOMAIL_API_URL = "";
process.env.RESEND_API_KEY = "";
process.env.EMAIL_FROM = "Sportozen <no-reply@example.test>";

type Mail = { to: string; subject: string; text: string; html?: string; key: string; auth: string; trackClicks: unknown; trackOpens: unknown };
const mails: Mail[] = [];
let zeptoStatus = 200;
let zeptoBody: unknown = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://api.zeptomail.com/v1.1/email")) {
    if (zeptoStatus !== 200) return new Response(JSON.stringify(zeptoBody ?? {}), { status: zeptoStatus });
    const body = JSON.parse(String(init?.body));
    mails.push({
      to: body.to[0].email_address.address,
      subject: body.subject,
      text: body.textbody,
      html: body.htmlbody,
      key: String(body.client_reference),
      auth: String((init?.headers as Record<string, string>).Authorization),
      trackClicks: body.track_clicks,
      trackOpens: body.track_opens,
    });
    return new Response(JSON.stringify({ data: [{ code: "EM_104", message: "OK" }], message: "OK", request_id: `zepto-req-${mails.length}` }), {
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
    app = await startHarness("zeptomail-onboarding-http");
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
const FORGOT = "/api/auth/onboarding/forgot-password";
const RESET = "/api/auth/onboarding/reset-password";
let counter = 0;
const freshEmail = () => `zepto-${++counter}-${Date.now().toString(36)}@example.test`;
const db = () => database();
const userByEmail = async (email: string) => (await db().select().from(t.user).where(eq(t.user.email, email)))[0];
const outboxOf = (userId: string) =>
  db().select().from(t.authEmailOutbox).where(eq(t.authEmailOutbox.userId, userId)).orderBy(desc(t.authEmailOutbox.createdAt));
async function mailTo(email: string) {
  await settleAuthEmailDelivery();
  return mails.filter((m) => m.to === email);
}
const codeIn = (mail: Mail) => /code is (\d{6})/.exec(mail.text)![1];
const tokenIn = (mail: Mail) => decodeURIComponent(/(https?:\/\/\S+)/.exec(mail.text)![1].split("#token=")[1]);
/** An account waiting for an emailed code, with the code requested through the real resend endpoint (signup needs no email). */
async function signUp(email = freshEmail()) {
  const { body, response } = await pendingVerificationAccount(app, { email });
  return { body, response };
}

test("verification code: emailed through ZeptoMail (auth header, no tracking), stored only sealed, and verifies the account", async () => {
  const { body, response } = await signUp();
  assert.equal(response.status, 200, response.text);
  const person = await userByEmail(body.email);
  assert.equal(person.emailVerified, false);
  const [mail] = await mailTo(body.email);
  assert.ok(mail, "the code was sent through the ZeptoMail endpoint");
  assert.equal(mail.auth, `Zoho-enczapikey ${TOKEN}`, "the prefixed token from the environment is sent once, not doubled");
  assert.equal(mail.trackClicks, false);
  assert.equal(mail.trackOpens, false);
  assert.match(mail.subject, /verif/i);
  const [row] = await outboxOf(person.id);
  assert.equal(row.status, "SENT");
  assert.match(row.providerMessageId ?? "", /^zepto-req-\d+$/, "ZeptoMail's request_id is recorded");
  assert.equal(row.sealedPayload, null, "the sealed message is wiped once sent");
  assert.equal(mail.key, row.idempotencyKey, "the outbox key travels as client_reference");
  // verification takes the password to install together with the code (typed twice)
  const verify = await app.anonymous().post(VERIFY, { email: body.email, code: codeIn(mail), password: body.password, confirmPassword: body.password });
  assert.equal(verify.status, 200, verify.text);
  assert.equal((await userByEmail(body.email)).emailVerified, true);
  await signedIn(app, body.email, body.password); // after verifying, the person signs in with the password they chose
});

test("password recovery: the emailed reset link (through ZeptoMail) sets a new password once", async () => {
  const first = await signUp();
  const [codeMail] = await mailTo(first.body.email);
  assert.equal((await app.anonymous().post(VERIFY, { email: first.body.email, code: codeIn(codeMail), password: first.body.password, confirmPassword: first.body.password })).status, 200);
  assert.deepEqual((await app.anonymous().post(FORGOT, { email: first.body.email })).json, GENERIC_RESET_RESPONSE);
  const reset = (await mailTo(first.body.email)).find((m) => m.subject.includes("Reset"));
  assert.ok(reset, "a verified account is emailed a reset link by ZeptoMail");
  assert.equal(reset!.trackClicks, false, "the link is not rewritten by click tracking");
  const chosen = NEW_PASSWORD();
  assert.equal((await app.anonymous().post(RESET, { token: tokenIn(reset!), password: chosen })).status, 200);
  assert.ok(await signedIn(app, first.body.email, chosen));
  const replay = await app.anonymous().post(RESET, { token: tokenIn(reset!), password: NEW_PASSWORD() });
  assert.notEqual(replay.status, 200, "the link is single use");
});

test("a ZeptoMail outage loses nothing: the email stays queued and sealed, and the worker path sends it later and retries", async () => {
  zeptoStatus = 503;
  try {
    const { response, body } = await signUp();
    assert.equal(response.status, 200, "signup does not depend on the provider being up");
    await settleAuthEmailDelivery();
    const person = await userByEmail(body.email);
    let [row] = await outboxOf(person.id);
    assert.equal(row.status, "FAILED_RETRYABLE");
    assert.equal(row.attempts, 1);
    assert.equal(row.lastErrorCode, "ZEPTOMAIL_HTTP_503");
    assert.ok(row.sealedPayload, "still queued");
    assert.ok(!row.sealedPayload!.includes(body.email) && !/\d{6}/.test(row.sealedPayload!), "sealed: no address or code in the clear");
    assert.equal((await mailTo(body.email)).length, 0);

    // Not due yet: a worker pass leaves it alone.
    const early = await deliverAuthEmailOnce(secret);
    assert.equal(early?.sent, 0);

    // Still down when it is due: retried again, attempts counted, nothing leaks into the stored error.
    await db().update(t.authEmailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(t.authEmailOutbox.id, row.id));
    const stillDown = await deliverAuthEmailOnce(secret);
    assert.equal(stillDown?.retried, 1);
    [row] = await outboxOf(person.id);
    assert.equal(row.status, "FAILED_RETRYABLE");
    assert.equal(row.attempts, 2);

    // Provider recovers: the worker pass delivers it.
    zeptoStatus = 200;
    await db().update(t.authEmailOutbox).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(t.authEmailOutbox.id, row.id));
    const summary = await deliverAuthEmailOnce(secret);
    assert.equal(summary?.sent, 1);
    assert.equal((await mailTo(body.email)).length, 1, "the worker delivered it");
    [row] = await outboxOf(person.id);
    assert.equal(row.status, "SENT");
    assert.equal(row.attempts, 3);
    assert.ok(row.providerMessageId?.startsWith("zepto-req-"));
    assert.equal(row.lastErrorCode, null);
    assert.equal(row.sealedPayload, null);
  } finally {
    zeptoStatus = 200;
    zeptoBody = null;
  }
});

test("a permanent ZeptoMail refusal (unverified sender domain) is recorded by its code, not retried, and leaks nothing", async () => {
  zeptoStatus = 400;
  zeptoBody = { error: { code: "TM_4001", message: `Sender domain not verified for ${TOKEN}`, details: [{ code: "SM_111", target: "from" }] } };
  try {
    const { response, body } = await signUp();
    assert.equal(response.status, 200, "signup still succeeds: the account exists and the person can ask for a new code");
    await settleAuthEmailDelivery();
    const [row] = await outboxOf((await userByEmail(body.email)).id);
    assert.equal(row.status, "FAILED_PERMANENT");
    assert.equal(row.lastErrorCode, "ZEPTOMAIL_TM_4001_SM_111");
    assert.equal(row.sealedPayload, null, "nothing sensitive is kept for a message that will never be sent");
    assert.ok(![row.lastErrorCode, row.providerMessageId ?? ""].join(" ").includes(TOKEN));
    assert.equal((await mailTo(body.email)).length, 0);
    // The worker never picks a permanent failure up again.
    const pass = await deliverAuthEmailOnce(secret);
    assert.equal(pass?.claimed, 0);
  } finally {
    zeptoStatus = 200;
    zeptoBody = null;
  }
});

test("with ZeptoMail configured password reset is on; without it reset (and the code step) say so, signup still works; no token reaches the public endpoint", async () => {
  const methods = await app.anonymous().get("/api/auth/account/sign-in-methods");
  const json = methods.json as { signup: Record<string, unknown>; passwordReset: { enabled: boolean } };
  assert.equal("enabled" in json.signup, false, "signup is never reported as disabled");
  assert.equal(json.passwordReset.enabled, true);
  assert.ok(!methods.text.includes(TOKEN), "no secret in the public endpoint");
  const saved = process.env.ZEPTOMAIL_TOKEN;
  process.env.ZEPTOMAIL_TOKEN = "";
  try {
    // A half-configured provider is not "delivery": password reset says so instead of pretending...
    const forgot = await app.anonymous().post(FORGOT, { email: freshEmail() });
    assert.equal(forgot.status, 503, forgot.text);
    assert.equal(code(forgot), "RESET_UNAVAILABLE");
    const off = (await app.anonymous().get("/api/auth/account/sign-in-methods")).json as { signup: Record<string, unknown>; passwordReset: { enabled: boolean } };
    assert.equal(off.passwordReset.enabled, false);
    assert.equal("enabled" in off.signup, false);
    // ...but creating an account needs no mail at all
    const body = { name: "Priya Mehta", email: freshEmail(), password: NEW_PASSWORD(), acceptTerms: true, termsVersion: TERMS_VERSION };
    const created = await app.anonymous().post(SIGNUP, body);
    assert.equal(created.status, 200, created.text);
    assert.equal((await userByEmail(body.email)).emailVerified, false);
  } finally {
    process.env.ZEPTOMAIL_TOKEN = saved;
  }
});
