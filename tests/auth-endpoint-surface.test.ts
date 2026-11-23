import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

/**
 * The complete list of endpoints the authentication instance exposes, pinned. Overnight audit finding S-1 was a stock Better Auth
 * endpoint (`/verify-password`) that the application never uses but that was reachable. A library upgrade or a new plugin can add
 * such an endpoint silently; this test fails when the surface changes, so each addition is looked at and either blocked
 * (`BLOCKED` in account-security.ts), covered by a test, or added here on purpose.
 *
 * Classification of the current surface:
 *   - the application's own endpoints:  /account/*, /onboarding/*, /invitations/*, /report-links/open
 *   - stock endpoints the application USES: sign-in/email, sign-in/social, sign-out, get-session, list-sessions,
 *     revoke-other-sessions, revoke-sessions (kept), link-social, callback/:id, error, ok, two-factor/enable|disable|verify-totp|
 *     verify-backup-code|generate-backup-codes, update-user (answers 403 for identity fields), update-session
 *   - stock endpoints that are NOT reachable by design (blocked by a hook, disabled by configuration, or inert without the
 *     option they need): change-password, request-password-reset, reset-password/:token, change-email, delete-user, sign-up/email,
 *     send-verification-email, get-access-token, refresh-token, list-accounts, account-info, unlink-account, verify-password,
 *     two-factor/get-totp-uri, two-factor/send-otp|verify-otp (no OTP sender configured: OTP_NOT_CONFIGURED)
 * tests/account-password.test.ts asserts the second group is refused over HTTP.
 */
const EXPECTED = `
GET /account-info
GET /account/academies
GET /account/mfa-policy
GET /account/security-state
GET /account/sign-in-methods
GET /delete-user/callback
GET /error
GET /list-accounts
GET /list-sessions
GET /ok
GET /reset-password/:token
GET|POST /callback/:id
GET|POST /get-session
POST (no http path) generateTOTP
POST (no http path) setPassword
POST (no http path) viewBackupCodes
POST /account/admin/reset-password
POST /account/change-password
POST /account/create-academy
POST /account/mfa-policy
POST /account/revoke-session
POST /account/select-academy
POST /account/unlink-google
POST /change-email
POST /delete-user
POST /get-access-token
POST /invitations/accept
POST /invitations/preview
POST /link-social
POST /onboarding/forgot-password
POST /onboarding/resend-verification
POST /onboarding/reset-password
POST /onboarding/signup
POST /onboarding/verify-email
POST /refresh-token
POST /report-links/open
POST /request-password-reset
POST /revoke-other-sessions
POST /revoke-sessions
POST /send-verification-email
POST /sign-in/email
POST /sign-in/social
POST /sign-out
POST /sign-up/email
POST /two-factor/disable
POST /two-factor/enable
POST /two-factor/generate-backup-codes
POST /two-factor/get-totp-uri
POST /two-factor/send-otp
POST /two-factor/verify-backup-code
POST /two-factor/verify-otp
POST /two-factor/verify-totp
POST /unlink-account
POST /update-session
POST /update-user
POST /verify-password
`
  .trim()
  .split("\n");

const scratch = mkdtempSync(join(tmpdir(), "auth-surface-"));
after(async () => {
  const { closeDatabase } = await import("../src/infrastructure/database/client");
  await closeDatabase();
  rmSync(scratch, { recursive: true, force: true });
});

test("the authentication instance exposes exactly the reviewed set of endpoints", async () => {
  process.env.BETTER_AUTH_SECRET = "surface-test-secret-0123456789abcdef0123456789";
  process.env.BETTER_AUTH_URL = "http://127.0.0.1:3999";
  process.env.LOCAL_DATABASE_PATH = join(scratch, "db");
  delete process.env.DATABASE_URL;
  // Google adds endpoints only when configured; the reviewed surface is the default (no Google) one.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  const { auth } = await import("../src/modules/identity/auth");
  const api = auth().api as unknown as Record<string, { path?: string; options?: { method?: string | string[] } }>;
  const actual = Object.entries(api)
    .map(([name, endpoint]) => {
      const methods = ([] as string[]).concat(endpoint.options?.method ?? "?").join("|");
      return endpoint.path ? `${methods} ${endpoint.path}` : `${methods} (no http path) ${name}`;
    })
    .sort();
  const expected = [...EXPECTED].sort();
  const added = actual.filter((line) => !expected.includes(line));
  const removed = expected.filter((line) => !actual.includes(line));
  assert.deepEqual({ added, removed }, { added: [], removed: [] }, "the endpoint surface changed: review every addition (block it, test it, or list it here on purpose)");
});
