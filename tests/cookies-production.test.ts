import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_PASSWORD, USERS } from "./helpers/fixtures";
import { corrupt } from "./helpers/client";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import { adminUrl } from "./helpers/test-database";
/**
 * Production-mode session cookies. NODE_ENV=production makes the application require a real
 * PostgreSQL (DATABASE_URL) and a configured private-media path, so this suite runs under
 * `npm run test:pg` and is reported as SKIPPED (never passed) without a disposable server.
 */
const skip = adminUrl()
  ? false
  : "TEST_POSTGRES_ADMIN_URL not set — run `npm run test:pg`";
let app: Harness | undefined;
before(
  async () => {
    if (!skip)
      app = await startHarness("cookies-production", { production: true });
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app?.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
test(
  "production runs in production mode on PostgreSQL",
  { skip, timeout: TEST_TIMEOUT },
  () => {
    assert.equal(process.env.NODE_ENV, "production");
    assert.equal(app!.database, "postgres");
  },
);
test(
  "production session cookie is __Secure- prefixed, Secure, HttpOnly, SameSite=Lax, host-only, 12 h",
  { skip, timeout: TEST_TIMEOUT },
  async () => {
    const client = app!.anonymous();
    const r = await client.signIn(USERS.owner.email, FIXTURE_PASSWORD);
    assert.equal(r.status, 200);
    const cookie = r.setCookies.find((c) => c.includes("session_token"));
    assert.ok(cookie, "no session cookie issued");
    assert.match(cookie, /^__Secure-better-auth\.session_token=/);
    assert.match(cookie, /;\s*Secure(;|$)/i);
    assert.match(cookie, /;\s*HttpOnly/i);
    assert.match(cookie, /;\s*SameSite=Lax/i);
    assert.match(cookie, /;\s*Path=\//i);
    assert.match(cookie, /;\s*Max-Age=43200(;|$)/i);
    assert.doesNotMatch(cookie, /;\s*Domain=/i, "cookie must be host-only");
    for (const other of r.setCookies)
      assert.ok(
        !/^better-auth\./.test(other),
        `unprefixed cookie issued: ${other.split("=")[0]}`,
      );
  },
);
test(
  "the prefixed cookie authenticates; the same value without the prefix, or tampered, does not",
  { skip, timeout: TEST_TIMEOUT },
  async () => {
    const client = app!.anonymous();
    await client.signIn(USERS.owner.email, FIXTURE_PASSWORD);
    const [name, value] = client.sessionCookie!;
    assert.match(name, /^__Secure-/);
    assert.equal((await client.get("/api/academy/identity")).status, 200);
    const probe = app!.anonymous();
    const bare = await probe.request("/api/academy/identity", {
      headers: { cookie: `${name.replace("__Secure-", "")}=${value}` },
    });
    assert.equal(
      bare.status,
      401,
      "an unprefixed cookie must not authenticate in production",
    );
    const tampered = await probe.request("/api/academy/identity", {
      headers: { cookie: `${name}=${corrupt(value)}` },
    });
    assert.equal(tampered.status, 401);
  },
);
test(
  "sign-out expires the production cookie under the same name and revokes the session",
  { skip, timeout: TEST_TIMEOUT },
  async () => {
    const client = app!.anonymous();
    await client.signIn(USERS.admin.email, FIXTURE_PASSWORD);
    const stolen = client.clone();
    const out = await client.signOut();
    assert.equal(out.status, 200);
    const cleared = out.setCookies.find((c) => c.includes("session_token"));
    assert.ok(cleared && /^__Secure-better-auth\.session_token=/.test(cleared));
    assert.match(cleared!, /Max-Age=0/i);
    assert.equal((await stolen.get("/api/academy/identity")).status, 401);
  },
);
