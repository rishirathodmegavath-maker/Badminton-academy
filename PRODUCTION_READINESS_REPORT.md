# Production readiness report (2026-11-13)

Assessment of the application **as built in the working tree**, with evidence. Nothing was deployed and no production system,
database or credential was touched. Status words: **Ready** (evidence shown), **Partial** (works, with a stated gap), **Gap**
(missing; needs a decision or work), **Not assessable** (nothing in the repository to inspect).

**Overall: not ready for a real launch yet.** The application code is in good shape on identity, tenant isolation, migrations and
build. The blockers are operational and one product gap: there is **no way to create the first academy and Owner in production**
(Phase 4C), **no deployment/CI/health/backup tooling in the repository**, and the **launch configuration trusts invitation links more than it
should** (S-3 in `OVERNIGHT_SECURITY_AUDIT.md`). Items are ordered by what blocks launch.

## 1. Launch blockers
| # | Item | Status | Evidence / what is needed |
|---|---|---|---|
| B1 | First academy and Owner in production | **Gap** | The only creator of an academy is `scripts/seed.ts`, which refuses production. Blueprint: `PHASE4_IMPLEMENTATION_BLUEPRINT.md` §C (needs approval). |
| B2 | Deployment artefacts | **Gap** | Repository has no Dockerfile, compose file, CI workflow, process-manager unit or reverse-proxy sample (`ls -a`). `next start` is the only documented run mode. |
| B3 | Readiness/health endpoint | **Gap** | Only Better Auth's `GET /api/auth/ok` (liveness; `{"ok":true}`; does not touch the database). A `SELECT 1` readiness route is advised. |
| B4 | Backup and restore for the production database | **Gap** | The repository documents the development folder (`MIGRATION_0018_EXECUTION_RUNBOOK.md`, `scripts/backup-dev-db.ps1`). A PostgreSQL backup, point-in-time recovery and restore-test procedure for production does not exist. |
| B5 | Invitation link as the only real secret (no-mail launch) | **Partial** | S-3. Mitigations without code: owner authenticator enforcement, short expiry, hand the link over person to person. Proper fix (passcode) needs approval. |
| B6 | Rotate the Google client secret that appeared in the session transcript | **Action for you** | Google Cloud console → OAuth client → reset secret; update the deployment's secret store (not `.env.local` in the repository folder). |

## 2. Configuration and secrets
| Check | Status | Evidence |
|---|---|---|
| Environment validation at start-up | **Ready** | `assertSecurityConfig` runs from `instrumentation.ts`; `npm run auth:check-config -- --production` prints names only. Synthetic good environment: "no errors"; synthetic bad environment (short secret, http URL, no `DATABASE_URL`, `0.0.0.0/0` proxy, half-set Google) reported 5 errors and 1 warning, exit 1. |
| A refused production start must look like a failed start | **Ready (fixed tonight)** | Before: Next printed "will not start" but **the process stayed alive without listening** (still running after 25 s; a supervisor would never restart or alert). Now `startup-guard.ts` exits with code 1: measured **exit code 1 after 3 s** on the real build; `tests/startup-guard.test.ts`. |
| Secrets never printed or logged | **Ready** | Four `console` sites in `src`; the config review emits names only (`tests/security-config.test.ts`); pool errors log name and code only (`tests/database-pool-guard.test.ts`). |
| `.env*` excluded from version control | **Ready** | `.gitignore`: `.env*`, `!.env.example`; `.env.example` holds names only (no value of 24+ characters). |
| `BETTER_AUTH_SECRET` | **Partial** | Validated (≥ 32 characters, not placeholder-like). It also encrypts authenticator secrets and recovery codes, so it cannot be rotated without every authenticator being reset; a rotation procedure is not written. |
| HTTPS | **Partial** | Production cookies are `__Secure-` / `Secure`; a non-https `BETTER_AUTH_URL` produces a warning, not an error (on purpose, for loopback testing). |
| Node/engine pinning | **Gap (minor)** | `package.json` has no `engines`; tested on Node 24.13.0. Add `engines` and an `.nvmrc`/image tag. |

## 3. Application behaviour in production mode
| Check | Status | Evidence |
|---|---|---|
| Error responses | **Ready** | Academy and training routes return a fixed generic 500 text and log only the error name; domain errors return their own safe messages; Better Auth errors are structured codes. Unknown routes: JSON 404. |
| Security headers | **Partial** | Served (verified with `curl -I` on the rebuilt production server): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`, `Cross-Origin-Opener-Policy: same-origin`; `X-Powered-By` removed. **Missing:** `Strict-Transport-Security` (set it at the TLS proxy), `Content-Security-Policy` (needs a nonce plan for Next's inline scripts). |
| Cookies | **Ready** | `__Secure-better-auth.session_token; HttpOnly; Secure; SameSite=Lax`, 12 hours (live `Set-Cookie`, `tests/cookies-production.test.ts`). |
| CSRF | **Ready** | `Origin` must equal the application origin on every non-GET (live probes: missing → 403, foreign → 403). |
| Rate limiting | **Partial** | Per-address limits on every sensitive endpoint, stored in the database (survives restarts and multiple instances), plus per-account throttle. Without `TRUSTED_PROXIES` all clients share one bucket per endpoint (safe, but one client can throttle everyone): **set `TRUSTED_PROXIES` to the real proxy addresses** (the start-up review warns). |
| Build | **Ready** | `npm run build` passes (Next 16.4.1; 25 pages; includes type-check of `src`, `scripts` and `tests`). |
| Dependency vulnerabilities | **Ready** | `npm audit` (production and dev): 0 vulnerabilities (2026-11-13). |
| Lint | **Not assessable** | There is no ESLint dependency or configuration in the project; only the strict TypeScript compiler (`npm run typecheck`, clean). Prettier is installed but not wired to a script. Adding ESLint is a new dependency and was not done unasked. |

## 4. Database
| Check | Status | Evidence |
|---|---|---|
| Connection handling | **Partial** | `pg` pool: max 20, idle timeout 30 s, connect timeout 5 s. **Fixed tonight:** the pool had no `error` listener, so an idle-connection failure (database restart/failover) crashed the process (`pool-guard.ts`, `tests/database-pool-guard.test.ts`). Not set: `statement_timeout`, `idle_in_transaction_session_timeout`, application-level SSL options (use `sslmode` in `DATABASE_URL`; verify the certificate). A restart-under-load rehearsal has not been run. |
| Migrations | **Ready** | Forward-only, journaled, one transaction each; `npm run db:migrate:plan` shows what would run; remote targets need `MIGRATION_CONFIRM_TARGET`; every migration 0004–0018 has a guarded rollback script (0012 onward hash-pinned). `tests/migrations.test.ts` (47 tests) and migration suites pass on PGlite and PostgreSQL 17/18. |
| Housekeeping of growing tables | **Gap (minor)** | Nothing deletes expired `session`, `verification` (reset tokens) or `auth_rate_limit` rows; `sign_in_throttle` and `totp_used` clean themselves. Growth is slow but unbounded. Add a scheduled SQL job. |
| Scheduled jobs | **Gap (docs)** | `npm run privacy:process` (erasures), `npm run auth:email-worker` (only with a mail provider) and outbox processing must be scheduled/supervised; no scheduler definition exists in the repository. |
| Table locking model | **Note** | Every write takes the academy row lock (`unit()`), which makes concurrency simple and safe but serialises one academy's writes; fine for an academy's size, worth a load test before onboarding many users per academy. |

## 5. Start-up, shutdown, observability
| Check | Status | Evidence |
|---|---|---|
| Start-up | **Ready** | Fail-fast on an unsafe production configuration (above). |
| Shutdown | **Partial** | No signal handler in the server beyond Next's own; the pool is not drained. Acceptable for stateless HTTP; add `pool.end()` on `SIGTERM` if connection counts matter. |
| Logging | **Partial** | Deliberately minimal and value-free; no request id in application logs, no structured format, no error-tracking integration. Security events and sensitive-access history are in the database and the owner UI. |
| Metrics / tracing | **Gap** | None. |

## 6. Operations documents
Present: `AUTH_ONBOARDING.md`, `ACCOUNT_SECURITY.md`, `RELEASE_PREREQUISITES.md`, `GOOGLE_SIGN_IN.md`, `PRIVACY_LIFECYCLE.md`, `MULTI_ACADEMY_IDENTITY_DESIGN.md`, operator CLIs
(`auth:recover`, `privacy:*`, `db:migrate*`), and tonight's `MIGRATION_0018_EXECUTION_RUNBOOK.md`.
Missing: production deployment guide, production backup/restore/DR runbook, incident runbook, secret-rotation procedure, upgrade/rollback procedure for the
application (not only the database).

## 7. Suggested order to reach "ready"
1. Approve and build Phase 4 (B1) and the invitation passcode (B5).
2. Choose the hosting model, then add a Dockerfile (or unit), a CI workflow (typecheck, `npm test`, `npm run test:pg` on 17 and 18, build, `npm audit`), and a reverse-proxy sample with HSTS and `TRUSTED_PROXIES` (B2).
3. Add `GET /api/health/ready` (database `SELECT 1`, migration count) and wire it into the platform (B3).
4. Write and **rehearse** the PostgreSQL backup/restore procedure with a restore test into a scratch database (B4); record RPO/RTO.
5. Run the restart-under-load rehearsal and a basic load test (many sign-ins, one busy academy).
6. Decide on CSP (nonce strategy) and add it behind a report-only header first.
7. Add the housekeeping job and the scheduler definitions (privacy, outbox, mail worker).
8. Rotate the Google secret (B6) and store all secrets in the deployment's secret manager.
