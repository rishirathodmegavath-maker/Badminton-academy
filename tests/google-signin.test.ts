import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { GOOGLE_REFUSAL_MESSAGES, googleConfig, googleRedirectUri, refusalFrom } from "../src/modules/identity/google";
import { checkSecurityConfig } from "../src/modules/identity/security-config";
import { auth } from "../src/modules/identity/auth";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { newMember, signedIn, code, hoursFromNow, STATE } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";

/**
 * "Continue with Google" (Phase 9). The whole flow runs over real HTTP against the real handlers; only Google's
 * token endpoint is stubbed, so the account policy is what is under test:
 *   - Google never creates an account and is never linked from an email address;
 *   - only a signed-in person links their own Google, with a verified email equal to the account's;
 *   - an account with an authenticator, an expired temporary password or no membership cannot use it;
 *   - the account gate, the audit log and the endpoint blocks all apply.
 * Live verification against Google itself needs real credentials (see GOOGLE_SIGN_IN.md).
 */
const CLIENT_ID = "test-client-id.apps.googleusercontent.com";
const CLIENT_SECRET = "test-client-secret-never-in-output-0123456789";
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;

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
      name: "Test Person",
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
  app = await startHarness("google-signin");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  globalThis.fetch = realFetch;
  await app?.stop();
});

const googleRows = (userId: string) =>
  database().select().from(t.account).where(and(eq(t.account.userId, userId), eq(t.account.providerId, "google")));
const eventsNamed = async (event: string) =>
  (await database().select().from(t.securityEvent)).filter((e) => e.event === event);
const sessionsFor = async (userId: string) =>
  (await database().select().from(t.session).where(eq(t.session.userId, userId))).length;
const location = (r: { headers: Headers }) => r.headers.get("location") ?? "";
const errorOf = (r: { headers: Headers }) => new URL(location(r), "http://x.invalid").searchParams.get("error");

/** Start the redirect flow and come back from "Google" as `profile`. `link` = signed-in person linking. */
async function viaGoogle(client: TestClient, profile: Profile, link = false) {
  const start = await client.post(link ? "/api/auth/link-social" : "/api/auth/sign-in/social", {
    provider: "google",
    callbackURL: link ? "/account?google=linked" : "/",
    errorCallbackURL: link ? "/account" : "/login",
    requestSignUp: false,
  });
  assert.equal(start.status, 200, start.text.slice(0, 200));
  const url = new URL((start.json as { url: string }).url);
  nextProfile = profile;
  const back = await client.get(`/api/auth/callback/google?code=stub-code&state=${url.searchParams.get("state")}`);
  return { start, authUrl: url, back };
}

test("configuration: both variables enable it, one alone is a reported problem, none turns it off", () => {
  assert.deepEqual(googleConfig({}), { enabled: false, problem: null });
  assert.equal(googleConfig({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }).enabled, true);
  assert.match(String((googleConfig({ GOOGLE_CLIENT_ID: "a" }) as { problem: string }).problem), /together/);
  assert.match(String((googleConfig({ GOOGLE_CLIENT_SECRET: "b", GOOGLE_CLIENT_ID: "  " }) as { problem: string }).problem), /together/);
  assert.equal(googleRedirectUri("https://app.example.test/"), "https://app.example.test/api/auth/callback/google");
  // start-up review: names only, never a value
  const half = checkSecurityConfig({ BETTER_AUTH_SECRET: "x".repeat(40), BETTER_AUTH_URL: "https://a.test", DATABASE_URL: "postgres://u:pw@h/db", GOOGLE_CLIENT_ID: "abc-secret-looking" }, "production");
  const finding = half.find((f) => f.variable === "GOOGLE_CLIENT_ID");
  assert.equal(finding?.level, "error");
  assert.ok(!JSON.stringify(half).includes("abc-secret-looking"));
  assert.equal(refusalFrom("account_not_linked"), "account_not_linked");
  assert.equal(refusalFrom("GOOGLE_SIGN_IN_NOT_AVAILABLE_WITH_MFA"), "mfa_enrolled");
  assert.equal(refusalFrom(null), "other");
});

test("the sign-in methods endpoint is public, says Google is on, and carries no secret", async () => {
  const r = await app.anonymous().get("/api/auth/account/sign-in-methods");
  assert.equal(r.status, 200);
  const body = r.json as { google: unknown; signup: Record<string, unknown>; passwordReset: { enabled: boolean } };
  assert.deepEqual(body.google, { enabled: true, linked: null, authenticator: null });
  // No mail provider here: password reset by email reports itself as off, signup is never reported as disabled.
  assert.equal(body.passwordReset.enabled, false);
  assert.equal("enabled" in body.signup, false);
  assert.ok(!r.text.includes(CLIENT_SECRET));
});

test("the authorization request goes to Google with the client id, our redirect URI, state and PKCE, never the secret", async () => {
  const start = await app.anonymous().post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/", errorCallbackURL: "/login" });
  assert.equal(start.status, 200);
  const url = new URL((start.json as { url: string }).url);
  assert.equal(url.host, "accounts.google.com");
  assert.equal(url.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), `${app.origin}/api/auth/callback/google`);
  assert.match(String(url.searchParams.get("scope")), /email/);
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(!start.text.includes(CLIENT_SECRET));
});

test("starting on one address and returning on another (127.0.0.1 vs localhost) is refused with an explanation, creates nothing, and is not mistaken for another failure", async () => {
  const users = (await database().select().from(t.user)).length;
  const start = await app.anonymous().post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/", errorCallbackURL: "/login" });
  const state = new URL((start.json as { url: string }).url).searchParams.get("state");
  // A different address is a different origin: the browser sends none of the cookies set by the first.
  const elsewhere = app.anonymous();
  nextProfile = { sub: "g-other-address", email: "other-address@example.test", email_verified: true };
  const back = await elsewhere.get(`/api/auth/callback/google?code=stub-code&state=${state}`);
  const error = new URL(back.headers.get("location") ?? "", "http://x.invalid").searchParams.get("error");
  assert.equal(error, "state_mismatch");
  assert.equal(refusalFrom(error), "wrong_address");
  assert.match(GOOGLE_REFUSAL_MESSAGES.wrong_address, /same web address/);
  assert.equal(elsewhere.hasSession(), false);
  assert.equal((await database().select().from(t.user)).length, users, "no account was created");
  for (const other of ["account_not_linked", "signup_disabled", "access_denied", "unable_to_get_user_info"])
    assert.notEqual(refusalFrom(other), "wrong_address", other);
});

test("a Google identity nobody provisioned is refused: no account, no session, one audit row", async () => {
  const before = (await database().select().from(t.user)).length;
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-stranger", email: "stranger.canary@example.test" });
  assert.equal(back.status, 302);
  assert.ok(errorOf(back), `redirected with an error: ${location(back)}`);
  assert.equal(client.hasSession(), false);
  assert.equal((await database().select().from(t.user)).length, before, "Google created no account");
  const refused = (await eventsNamed("GOOGLE_SIGN_IN_REFUSED")).filter((e) => (e.detail as { reason?: string }).reason);
  assert.ok(refused.length >= 1);
});

test("an existing provisioned account is NOT linked from a matching verified email (implicit linking is off)", async () => {
  const member = await newMember("COACH");
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-implicit", email: member.email, email_verified: true });
  assert.equal(client.hasSession(), false, "no session from an email match");
  assert.ok(errorOf(back));
  assert.equal((await googleRows(member.id)).length, 0, "nothing was linked");
  assert.equal(await sessionsFor(member.id), 0);
});

test("linking: a signed-in person links Google (verified, same email), tokens are not stored, and it is audited", async () => {
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  const { back } = await viaGoogle(me, { sub: "g-link-ok", email: member.email, email_verified: true }, true);
  assert.equal(back.status, 302);
  assert.match(location(back), /\/account\?google=linked/);
  const rows = await googleRows(member.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].accountId, "g-link-ok");
  assert.equal(rows[0].accessToken, null);
  assert.equal(rows[0].refreshToken, null);
  assert.equal(rows[0].idToken, null);
  const linked = (await eventsNamed("GOOGLE_LINKED")).filter((e) => e.targetUserId === member.id);
  assert.equal(linked.length, 1);
  const methods = await me.get("/api/auth/account/sign-in-methods");
  assert.deepEqual((methods.json as { google: { linked: boolean } }).google.linked, true);
  // the audit rows hold no token and no Google subject
  assert.ok(!JSON.stringify(linked).includes("g-link-ok"));
});

test("after linking, Google signs that person in, the session works, and it is audited", async () => {
  const member = await newMember("HEAD_COACH");
  const me = await signedIn(app, member.email);
  await viaGoogle(me, { sub: "g-signin", email: member.email }, true);
  const fresh = app.anonymous();
  const { back } = await viaGoogle(fresh, { sub: "g-signin", email: member.email });
  assert.equal(back.status, 302);
  assert.equal(location(back), "/");
  assert.ok(fresh.hasSession(), "a session cookie was issued");
  const identity = await fresh.get("/api/academy/identity");
  assert.equal(identity.status, 200);
  assert.equal((identity.json as { role: string }).role, "HEAD_COACH");
  assert.equal((await eventsNamed("GOOGLE_SIGN_IN")).filter((e) => e.targetUserId === member.id).length, 1);
});

test("linking is refused when Google's email differs, is unverified, or the Google identity belongs to someone else", async () => {
  const a = await newMember("COACH");
  const b = await newMember("COACH");
  const meA = await signedIn(app, a.email);
  const different = await viaGoogle(meA, { sub: "g-diff", email: "someone.else@example.test" }, true);
  assert.ok(errorOf(different.back));
  const unverified = await viaGoogle(meA, { sub: "g-unv", email: a.email, email_verified: false }, true);
  assert.ok(errorOf(unverified.back));
  assert.equal((await googleRows(a.id)).length, 0);
  // b links first; a then tries to link the same Google subject
  const meB = await signedIn(app, b.email);
  await viaGoogle(meB, { sub: "g-shared", email: b.email }, true);
  const clash = await viaGoogle(meA, { sub: "g-shared", email: a.email }, true);
  assert.ok(errorOf(clash.back));
  assert.equal((await googleRows(a.id)).length, 0);
  assert.equal((await googleRows(b.id)).length, 1);
});

test("a person without an active membership and without a verified email cannot link Google", async () => {
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  await database().update(t.memberships).set({ active: false }).where(eq(t.memberships.userId, member.id));
  await database().update(t.user).set({ emailVerified: false }).where(eq(t.user.id, member.id));
  const { back } = await viaGoogle(me, { sub: "g-inactive", email: member.email }, true);
  assert.ok(errorOf(back) ?? back.status >= 400);
  assert.equal((await googleRows(member.id)).length, 0);
});

test("an account with an authenticator app cannot start a session through Google (the two-factor step would be skipped)", async () => {
  const member = await newMember("COACH");
  await database().insert(t.account).values({ id: `g-${member.id}`, accountId: "g-mfa", providerId: "google", userId: member.id });
  await database().update(t.user).set({ twoFactorEnabled: true }).where(eq(t.user.id, member.id));
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-mfa", email: member.email });
  assert.equal(client.hasSession(), false);
  assert.ok(errorOf(back));
  assert.equal(await sessionsFor(member.id), 0);
  const refused = (await eventsNamed("GOOGLE_SIGN_IN_REFUSED")).filter((e) => e.targetUserId === member.id);
  assert.equal(refused.length, 1);
  assert.equal((refused[0].detail as { reason: string }).reason, "mfa_enrolled");
});

test("an expired temporary password cannot become a session through Google either", async () => {
  const member = await newMember("COACH");
  await database().insert(t.account).values({ id: `g-${member.id}`, accountId: "g-expired", providerId: "google", userId: member.id });
  await database().insert(t.temporaryCredential).values({ userId: member.id, source: "OWNER_RESET", issuedAt: hoursFromNow(-48), expiresAt: hoursFromNow(-24) });
  const client = app.anonymous();
  const { back } = await viaGoogle(client, { sub: "g-expired", email: member.email });
  assert.equal(client.hasSession(), false);
  assert.ok(errorOf(back));
  assert.equal(await sessionsFor(member.id), 0);
});

test("the account gate still applies to a Google session: a pending forced password change blocks the application", async () => {
  const member = await newMember("COACH");
  await database().insert(t.account).values({ id: `g-${member.id}`, accountId: "g-gated", providerId: "google", userId: member.id });
  await database().insert(t.temporaryCredential).values({ userId: member.id, source: "OWNER_RESET", issuedAt: hoursFromNow(-1), expiresAt: hoursFromNow(24) });
  const client = app.anonymous();
  await viaGoogle(client, { sub: "g-gated", email: member.email });
  assert.ok(client.hasSession());
  const blocked = await client.get("/api/academy/identity");
  assert.equal(blocked.status, 403);
  assert.equal(code(blocked), "PASSWORD_CHANGE_REQUIRED");
  assert.equal(((await client.get(STATE)).json as { gate: string }).gate, "PASSWORD_CHANGE_REQUIRED");
});

test("endpoints that would hand out or refresh provider tokens are not available", async () => {
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  for (const [path, method] of [
    ["/api/auth/get-access-token", "POST"],
    ["/api/auth/refresh-token", "POST"],
    ["/api/auth/account-info", "GET"],
    ["/api/auth/list-accounts", "GET"],
  ] as const) {
    const r = method === "GET" ? await me.get(path) : await me.post(path, { providerId: "google" });
    assert.equal(r.status, 404, path);
    assert.equal(code(r), "NOT_AVAILABLE", path);
  }
});

test("unlinking works, is audited, and Google sign-in stops working", async () => {
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  await viaGoogle(me, { sub: "g-unlink", email: member.email }, true);
  // the stock route (which needs the provider's internal id) is closed; ours unlinks the caller's own link
  const stock = await me.post("/api/auth/unlink-account", { providerId: "google", accountId: "g-unlink" });
  assert.equal(code(stock), "NOT_AVAILABLE");
  assert.equal((await googleRows(member.id)).length, 1, "the closed route changed nothing");
  const r = await me.post("/api/auth/account/unlink-google", {});
  assert.equal(r.status, 200, r.text.slice(0, 160));
  const again = await me.post("/api/auth/account/unlink-google", {});
  assert.equal(again.status, 404);
  assert.equal((await googleRows(member.id)).length, 0);
  assert.equal((await eventsNamed("GOOGLE_UNLINKED")).filter((e) => e.targetUserId === member.id).length, 1);
  const client = app.anonymous();
  await viaGoogle(client, { sub: "g-unlink", email: member.email });
  assert.equal(client.hasSession(), false);
  // the password still works
  assert.ok(await signedIn(app, member.email));
});

test("Google's own sign-up and linking routes are covered by rate limits, and sign-up by email stays disabled", async () => {
  const rules = (auth() as unknown as { options: { rateLimit: { customRules: Record<string, { max: number }> } } }).options.rateLimit.customRules;
  for (const path of ["/sign-in/social", "/callback/*", "/link-social", "/account/unlink-google"]) assert.ok(rules[path], `${path} has a rule`);
  const r = await app.anonymous().post("/api/auth/sign-up/email", { email: "new.person@example.test", password: "Orchid-Lantern-Meadow-1-Quartz", name: "New" });
  assert.ok(r.status >= 400);
  assert.equal((await database().select().from(t.user).where(eq(t.user.email, "new.person@example.test"))).length, 0);
});
