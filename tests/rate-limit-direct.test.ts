import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FIXTURE_PASSWORD, USERS } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
/**
 * Sign-in rate limiting when NO trusted proxy is configured (TRUSTED_PROXIES unset) and the app is
 * exposed directly, exactly as `next start` exposes it: Next only fills X-Forwarded-For from the
 * socket when the client did not send one, so a client-supplied header is never trustworthy.
 *
 * The safe failure is ONE shared bucket per endpoint: guessing stays limited whatever headers an
 * attacker sends, at the price that one attacker can also throttle everybody (documented).
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("rate-limit-direct", { proxy: "direct" });
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
test(
  "no forwarding header, forged headers or rotating addresses can escape the limit",
  { timeout: TEST_TIMEOUT },
  async () => {
    const attempts: Record<string, string>[] = [
      {}, // header absent: Next fills it from the socket
      { "x-forwarded-for": "203.0.113.1" },
      { "x-forwarded-for": "203.0.113.2" },
      { "x-forwarded-for": "2001:db8::1" },
      { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
      { "x-forwarded-for": "not-an-address" },
      ...Array.from({ length: 24 }, (_, i) => ({
        "x-forwarded-for": `198.51.100.${i + 1}`,
      })),
    ];
    const results: number[] = [];
    for (const [i, headers] of attempts.entries()) {
      const client = app.anonymous(`192.0.2.${i + 1}`); // also a different "machine" each time
      const r = await client.signIn(
        USERS.owner.email,
        `wrong-guess-${i}-zzzzzzzz`,
        {
          headers,
          noPeer: true,
        },
      );
      results.push(r.status);
    }
    assert.equal(results.filter((s) => s === 401).length, 5, results.join());
    assert.equal(results.filter((s) => s === 429).length, attempts.length - 5);
    assert.deepEqual(results.slice(0, 5), [401, 401, 401, 401, 401]);
  },
);
test(
  "documented fail-safe trade-off: while throttled, even a legitimate user is refused",
  { timeout: TEST_TIMEOUT },
  async () => {
    const legit = app.anonymous("192.0.2.200");
    const r = await legit.signIn(USERS.owner.email, FIXTURE_PASSWORD, {
      headers: { "x-forwarded-for": "198.51.100.250" },
      noPeer: true,
    });
    assert.equal(r.status, 429);
  },
);
