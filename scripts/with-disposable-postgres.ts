import { spawn } from "node:child_process";
import { withDisposablePostgres } from "./lib/disposable-postgres";
/**
 * Runs the PostgreSQL-dependent tests against a throw-away PostgreSQL container (Docker required):
 *   npm run test:pg [-- tests/some.test.ts ...]
 * Cleanup is guaranteed on success, failure, timeout and SIGINT/SIGTERM (see lib/disposable-postgres).
 * Environment: TEST_POSTGRES_IMAGE (default postgres:17-alpine), TEST_PG_TIMEOUT_MS (default 30 min).
 */
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "tests/migrations.test.ts",
      "tests/docker-runner.test.ts",
      "tests/http-auth.test.ts",
      "tests/cookies-production.test.ts",
      "tests/role-fixtures.test.ts",
      "tests/role-payload.test.ts",
      "tests/cross-academy.test.ts",
      "tests/rate-limit-proxy.test.ts",
      "tests/rate-limit-direct.test.ts",
      "tests/account-password.test.ts",
      "tests/account-reset.test.ts",
      "tests/account-lifecycle.test.ts",
      "tests/mfa.test.ts",
      "tests/mfa-rollout.test.ts",
      // Phase 2.3 - 4: data access, security events, atomic throttles, MFA policy.
      "tests/data-access.test.ts",
      "tests/security-event-log.test.ts",
      "tests/account-hardening.test.ts",
      "tests/mfa-policy.test.ts",
      // Phase 5: consent history, versions and authority.
      "tests/consent.test.ts",
      // Phase 6: report and nutrition-plan withdrawal.
      "tests/withdrawal.test.ts",
      // Phase 7: sensitive-data access auditing.
      "tests/access-audit.test.ts",
      // Phase 8: retention, erasure, legal holds and restore safeguards.
      "tests/privacy.test.ts",
      // Stage 3: profile/attribution integrity and academy-membership resolution.
      "tests/profile-attribution.test.ts",
      "tests/membership-resolution.test.ts",
      // Stage 4: training-draft versioning, conflicts and isolation.
      "tests/training-draft-concurrency.test.ts",
      // Stage 5B: fee, payment, refund, calendar and training-session logic, previously PGlite-only.
      "tests/operations.test.ts",
      "tests/monthly-report.test.ts",
      "tests/training.test.ts",
      // Stage 5B: one currency per academy (rules, change guard, concurrency).
      "tests/currency-integrity.test.ts",
      // Stage 5C: payment attempts, reference normalization, pending limit, database backstops.
      "tests/payment-attempts.test.ts",
      // Stage 5D: coach deactivation, replacement hand-over and batch-assignment integrity.
      "tests/coach-assignment.test.ts",
      // Stage 5E: recurring calendar series (scopes, exceptions, history, concurrency, time zones).
      "tests/calendar-series.test.ts",
      // Stage 5F: family-scoped portal reads (equivalence, isolation, empty scope, invoices, ledger).
      "tests/family-portal-isolation.test.ts",
      // Stage 5F correction (D-5b): zero-child invoices addressed to one family account, through the HTTP routes.
      "tests/family-invoice-recipient.test.ts",
      // Role consolidation RC-1: authority module equivalence (T-EQ) and HTTP authority boundaries.
      "tests/authority-equivalence.test.ts",
      "tests/authority-http.test.ts",
      // Role consolidation RC-3: migration 0013 (role CHECK, last-active-owner trigger, pre-flights, rollback) - AT-11.
      "tests/migrations-0013.test.ts",
      // RC-3 F-01/F-02: deterministic concurrent direct-SQL owner races (separate file: its own time budget).
      "tests/migrations-0013-concurrency.test.ts",
      // RC-3 F-03: the database's OWNER_REQUIRED refusal reported as 409 LAST_OWNER (and nothing else is).
      "tests/owner-presence-translation.test.ts",
      // Role consolidation RC-4: migration 0014 (grant table, append-only history, guarded rollback). The adult-controlled
      // guardian-access suites (adult-guardian-access, rc5-guardian-access-http, rc5-message-withholding) were retired when
      // adult players stopped existing (see ACCEPTANCE_HARDENING_REPORT.md).
      "tests/migrations-0014.test.ts",
      // Role consolidation RC-5: staff portal authorization (server read model, exports, forged requests, re-roled membership).
      "tests/rc5-staff-portal-http.test.ts",
      // A stored legacy adult profile cannot be silently turned into a minor profile by editing it.
      "tests/legacy-adult-profile.test.ts",
      // Auth integration Phase 1: migration 0015 (onboarding columns, Better Auth indexes, email outbox) + outbox dispatch.
      "tests/migrations-0015.test.ts",
      "tests/auth-email-outbox.test.ts",
      // Auth integration Phase 2: public signup, email OTP verification, password recovery and Google sign-up policy over HTTP.
      "tests/onboarding-http.test.ts",
      "tests/zeptomail-onboarding-http.test.ts",
      "tests/google-signup.test.ts",
      // Sign-in and sign-up must not depend on a mail provider; only password recovery does.
      "tests/auth-without-email-provider.test.ts",
      // E-mail (ZeptoMail) and WhatsApp (Meta Cloud API) delivery through the outbox, the registered phone number, migration 0016.
      "tests/comms-providers.test.ts",
      "tests/comms-dispatch.test.ts",
      "tests/comms-phone.test.ts",
      "tests/migrations-0016.test.ts",
      // Multi-academy identity (0017): selection, switching, side effects, owner recovery, F-01 scope.
      "tests/migrations-0017.test.ts",
      "tests/multi-academy-selection.test.ts",
      "tests/multi-academy-side-effects.test.ts",
      "tests/privacy-process-scope.test.ts",
      // Invitations (0018): migration, lifecycle, acceptance races, authorization, guardians, isolation.
      "tests/migrations-0018.test.ts",
      "tests/invitations-http.test.ts",
      // Overnight audit: a person who owns two academies cannot reach one by id while working in the other (reads and writes).
      "tests/dual-academy-idor.test.ts",
    ];
try {
  const code = await withDisposablePostgres(
    async (pg, signal) => {
      console.log(`Disposable ${pg.version} on ${new URL(pg.url).host}`);
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          "--test-timeout=240000",
          "--test-concurrency=3",
          ...files,
        ],
        {
          stdio: "inherit",
          env: { ...process.env, TEST_POSTGRES_ADMIN_URL: pg.url },
        },
      );
      signal.addEventListener("abort", () => child.kill());
      return new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (status) =>
          signal.aborted ? reject(signal.reason) : resolve(status ?? 1),
        );
      });
    },
    { totalTimeoutMs: Number(process.env.TEST_PG_TIMEOUT_MS) || 30 * 60_000 },
  );
  console.log("Disposable PostgreSQL container removed.");
  process.exitCode = code;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Disposable PostgreSQL container removed.");
  process.exitCode = 1;
}
