import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_PASSWORD, USERS } from "./helpers/fixtures";
import { NO_PEER } from "./helpers/http-server";
import { TRUSTED_PROXY_ADDRESS } from "./helpers/harness";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
/**
 * Sign-in rate limiting behind a TRUSTED reverse proxy (TRUSTED_PROXIES configured). The test
 * server plays nginx: it keeps any X-Forwarded-For the client sent on the left and APPENDS the
 * connecting peer on the right. Only that appended address may identify the client.
 *
 * Regression for the original defect: rotating forged X-Forwarded-For values used to give an
 * attacker unlimited password guesses (30 guesses, all answered 401).
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("rate-limit-proxy", { proxy: "proxy" });
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const guess = (
  client: ReturnType<Harness["anonymous"]>,
  i: number,
  headers: Record<string, string> = {},
  password = `wrong-guess-${i}-zzzzzzzz`,
) =>
  // Every guess targets its own account name (valid e-mail syntax, even for IPv6 peers). This suite measures the per-ADDRESS
  // limiter; guessing at one shared account would instead trip the separate per-account throttle
  // (tests/account-lifecycle.test.ts) once ten failures accumulate across scenarios. The
  // correct-password controls below still use the real fixture account.
  client.signIn(
    `probe-${client.address.replace(/[^a-z0-9]/gi, "-")}-${i}@example.test`,
    password,
    { headers },
  );
const statuses = async (
  client: ReturnType<Harness["anonymous"]>,
  n: number,
  headersFor: (i: number) => Record<string, string> = () => ({}),
) => {
  const out: number[] = [];
  for (let i = 0; i < n; i++)
    out.push((await guess(client, i, headersFor(i))).status);
  return out;
};
test(
  "the limit is exactly five failed attempts per minute per client, and a correct password cannot bypass it",
  { timeout: TEST_TIMEOUT },
  async () => {
    const attacker = app.anonymous("203.0.113.10");
    assert.deepEqual(
      await statuses(attacker, 6),
      [401, 401, 401, 401, 401, 429],
    );
    assert.equal(
      (await attacker.signIn(USERS.owner.email, FIXTURE_PASSWORD)).status,
      429,
      "the correct password must not bypass a throttled client",
    );
  },
);
test(
  "rotating forged X-Forwarded-For values cannot bypass the limiter (original defect)",
  { timeout: TEST_TIMEOUT },
  async () => {
    const attacker = app.anonymous("203.0.113.20");
    const result = await statuses(attacker, 30, (i) => ({
      "x-forwarded-for": `198.51.${i}.${100 + i}`,
    }));
    assert.equal(result.filter((s) => s === 401).length, 5, result.join());
    assert.equal(result.filter((s) => s === 429).length, 25, result.join());
    assert.deepEqual(result.slice(0, 5), [401, 401, 401, 401, 401]);
  },
);
test(
  "forged, multi-hop, IPv6, junk and empty forwarding headers are all ignored in favour of the proxy-appended address",
  { timeout: TEST_TIMEOUT },
  async () => {
    const forgeries = [
      "10.0.0.1, 10.0.0.2",
      "::1",
      "2001:db8::dead:beef",
      "127.0.0.1",
      "unknown",
      "999.999.999.999",
      "'; drop table auth_rate_limit; --",
      "",
      "a".repeat(2000),
    ];
    let peer = 30;
    for (const forged of forgeries) {
      const client = app.anonymous(`203.0.113.${peer++}`);
      const result = await statuses(client, 6, () => ({
        "x-forwarded-for": forged,
      }));
      assert.deepEqual(
        result,
        [401, 401, 401, 401, 401, 429],
        `forged header ${JSON.stringify(forged.slice(0, 40))} changed the outcome`,
      );
    }
  },
);
test(
  "legitimate clients behind the proxy are isolated from each other, even when they send identical headers",
  { timeout: TEST_TIMEOUT },
  async () => {
    const attacker = app.anonymous("203.0.113.100");
    const neighbour = app.anonymous("203.0.113.101");
    const same = () => ({ "x-forwarded-for": "192.0.2.77" });
    assert.deepEqual(
      await statuses(attacker, 6, same),
      [401, 401, 401, 401, 401, 429],
    );
    const signedIn = await neighbour.signIn(
      USERS.owner.email,
      FIXTURE_PASSWORD,
      {
        headers: same(),
      },
    );
    assert.equal(
      signedIn.status,
      200,
      "an unrelated client must not be throttled",
    );
  },
);
test(
  "IPv6 clients are limited per /64 network, so one host cannot rotate through addresses",
  { timeout: TEST_TIMEOUT },
  async () => {
    const a = app.anonymous("2001:db8:1:1::1");
    const b = app.anonymous("2001:db8:1:1::ffff");
    const other = app.anonymous("2001:db8:1:2::1");
    const result: number[] = [];
    for (let i = 0; i < 3; i++) result.push((await guess(a, i)).status);
    for (let i = 3; i < 6; i++) result.push((await guess(b, i)).status);
    assert.deepEqual(result, [401, 401, 401, 401, 401, 429]);
    assert.equal(
      (await other.signIn(USERS.owner.email, FIXTURE_PASSWORD)).status,
      200,
      "a different /64 is a different client",
    );
  },
);
test(
  "a proxy that forwards no address (misconfiguration) fails safe into one shared bucket",
  { timeout: TEST_TIMEOUT },
  async () => {
    const a = app.anonymous(NO_PEER);
    const b = app.anonymous(NO_PEER);
    const result: number[] = [];
    for (let i = 0; i < 3; i++) result.push((await guess(a, i)).status);
    for (let i = 3; i < 6; i++) result.push((await guess(b, i)).status);
    assert.deepEqual(result, [401, 401, 401, 401, 401, 429]);
  },
);
test(
  "the global limiter and other endpoints are untouched by the address policy",
  { timeout: TEST_TIMEOUT },
  async () => {
    const client = app.anonymous("203.0.113.150");
    // 12 requests to a different endpoint from one client all succeed (well under 60/min).
    for (let i = 0; i < 12; i++)
      assert.equal((await client.get("/api/auth/get-session")).status, 200);
  },
);
test(
  "LIMITATION (characterisation): an address listed in TRUSTED_PROXIES is believed when it forwards, so end-user addresses must never be listed",
  { timeout: TEST_TIMEOUT },
  async () => {
    // If a client connects FROM a trusted address (a too-broad CIDR that contains users, or an
    // attacker inside the trusted network), the proxy-appended hop is skipped and the forged
    // value to its left is believed. This is the trusted-proxy model, not a bug in the limiter;
    // the README says what may be listed. The test pins the behaviour so a change is noticed.
    const insider = app.anonymous(TRUSTED_PROXY_ADDRESS);
    const result = await statuses(insider, 12, (i) => ({
      "x-forwarded-for": `198.18.${i}.1`,
    }));
    assert.equal(
      result.filter((s) => s === 429).length,
      0,
      "behaviour changed: re-evaluate the TRUSTED_PROXIES documentation",
    );
  },
);
