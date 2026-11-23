import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { newMember, signedIn } from "./helpers/accounts";

/**
 * With no Google credentials configured nothing about Google exists: the login screen is told so (and shows
 * no button), starting a Google sign-in or link fails, and password sign-in is unaffected.
 */
let app: Harness;
before(async () => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  app = await startHarness("google-disabled");
}, { timeout: HOOK_TIMEOUT });
after(async () => app?.stop());

test("the login screen is told Google is off", async () => {
  const r = await app.anonymous().get("/api/auth/account/sign-in-methods");
  assert.equal(r.status, 200);
  assert.deepEqual((r.json as { google: unknown }).google, { enabled: false, linked: null, authenticator: null });
});

test("starting a Google sign-in or a link fails and issues no session or redirect to Google", async () => {
  const anonymous = app.anonymous();
  const start = await anonymous.post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/", errorCallbackURL: "/login" });
  assert.ok(start.status >= 400, `status ${start.status}`);
  assert.ok(!start.text.includes("accounts.google.com"));
  assert.equal(anonymous.hasSession(), false);
  const member = await newMember("COACH");
  const me = await signedIn(app, member.email);
  const link = await me.post("/api/auth/link-social", { provider: "google", callbackURL: "/account", errorCallbackURL: "/account" });
  assert.ok(link.status >= 400);
  assert.ok(!link.text.includes("accounts.google.com"));
});

test("password sign-in is unaffected", async () => {
  const member = await newMember("COACH");
  assert.ok(await signedIn(app, member.email));
});
