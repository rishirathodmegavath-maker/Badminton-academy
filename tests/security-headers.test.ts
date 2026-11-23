import assert from "node:assert/strict";
import test from "node:test";
import config from "../next.config";

/**
 * The response headers the application itself sets (next.config.ts). HSTS and a Content-Security-Policy are deliberately NOT
 * here: HSTS belongs at the TLS-terminating proxy (a wrong one cannot be undone from the server), and a CSP needs a nonce
 * strategy for Next's inline bootstrap scripts; both are listed in PRODUCTION_READINESS_REPORT.md.
 */
test("every route carries the baseline hardening headers and the framework is not announced", async () => {
  assert.equal(config.poweredByHeader, false);
  const rules = await config.headers!();
  const all = rules.find((r) => r.source === "/:path*");
  assert.ok(all, "a rule that covers every path");
  const header = (key: string) => all.headers.find((h) => h.key === key)?.value;
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  assert.equal(header("X-Frame-Options"), "DENY");
  // Same-origin referrers only: nothing about our URLs (an invitation page, a reset page) is ever sent to another site.
  assert.equal(header("Referrer-Policy"), "same-origin");
  assert.equal(header("Cross-Origin-Opener-Policy"), "same-origin");
  const permissions = header("Permissions-Policy") ?? "";
  for (const feature of ["camera", "microphone", "geolocation", "payment", "usb"]) assert.match(permissions, new RegExp(`${feature}=\(\)`));
});
