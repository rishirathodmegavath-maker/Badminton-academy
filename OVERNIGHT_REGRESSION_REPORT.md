# Overnight regression and architecture report (2026-11-13)

What was reviewed, what was changed and why, every test that was added or corrected, and the **exact** results of the final
verification runs. Where something could not be run, the limitation is stated and nothing is claimed for it.

## 1. Changes made tonight (all uncommitted; nothing committed, pushed or deployed)

### Application and configuration code
| File | Change | Why / evidence |
|---|---|---|
| `src/modules/identity/account-security.ts` | `"/verify-password"` added to the blocked stock routes | S-1: password-guessing oracle for a session holder. Test fails without it (negative control run). |
| `src/infrastructure/database/client.ts`, **new** `pool-guard.ts` | the `pg` Pool gets an `error` listener (name and code logged only) | S-2: an idle-connection failure threw an uncaught exception and ended the process. |
| `src/instrumentation.ts`, **new** `src/modules/identity/startup-guard.ts` | an unsafe production configuration now **exits with code 1** | Before: "will not start" was printed but the process stayed alive and not listening. Measured on the real build: exit 1 after 3 s. |
| `src/modules/identity/security-config.ts` | production warns by name when `PRIVATE_MEDIA_PATH` or `ERASURE_LEDGER_PATH` is unset | Production uploads answered 503 on first use with no earlier signal. Found because a browser spec failed on the disposable server. |
| `next.config.ts` | `poweredByHeader: false`; `Permissions-Policy`; `Cross-Origin-Opener-Policy: same-origin` | S-4; verified with `curl -I` on the production build. |
| `.env.example` | `PRIVATE_MEDIA_PATH=` and `ERASURE_LEDGER_PATH=` documented | README already required them; the example did not list them. |

### Tooling and scripts
| File | Purpose |
|---|---|
| **new** `scripts/e2e-server.ts`, `scripts/lib/e2e-server-env.ts` | Deterministic disposable test server (`--profile plain` or `fake-google`): builds the child's environment from scratch, forces every Google/mail/MFA/proxy variable empty (an empty value beats `.env.local` in Next's loader, proven by a test against the real loader), refuses port 3100 and any database that is not a loopback `sportozen_e2e`. Fixes the `auth-no-email.spec` environment dependence without touching `.env.local`. |
| **new** `scripts/backup-dev-db.ps1` | Backup / Verify / Restore of the embedded development database with SHA-256 manifest; refuses a live folder, refuses to overwrite, verifies before restoring. Tested only on scratch copies. |
| **new** `scripts/dev-db-tool.ts` | Read-only `state` and guarded `run-sql` for the embedded database (used by the 0018 runbook). Tested on the scratch copy. |
| `scripts/with-disposable-postgres.ts` | `tests/dual-academy-idor.test.ts` added to the default PostgreSQL list. |

### Tests added (12 tests in 6 new files, plus 1 in an existing file)
| File | Tests | What it proves |
|---|---|---|
| `tests/dual-academy-idor.test.ts` | 2 | A person who is **Owner of both academies**, working in one, cannot read or write the other's reports, media, receipts, consent, refunds or invitations by id; controls succeed in the owning academy; **mutation check:** removing the academy filter from `revokeInvitation` makes it fail. |
| `tests/auth-endpoint-surface.test.ts` | 1 | The authentication instance exposes exactly the 54 reviewed endpoints. A library upgrade that adds a stock endpoint (the cause of S-1) fails the test until it is reviewed. |
| `tests/database-pool-guard.test.ts` | 2 | Real `pg` Pool: without the guard `emit('error')` throws; with it nothing throws and a connection string in the message is not logged. |
| `tests/startup-guard.test.ts` | 2 | Unsafe production configuration → exit code 1 and value-free findings; safe production and any development configuration → no exit. |
| `tests/security-headers.test.ts` | 1 | The baseline response headers and `poweredByHeader: false`. |
| `tests/e2e-server-env.test.ts` | 4 | The launcher forwards no credential, forces controlled settings empty, refuses unsafe targets, and the **real Next env loader** does not let `.env.local` re-enable Google, mail or MFA. |
| (in existing `tests/security-config.test.ts`) | +1 | Production warns about missing storage paths by name; development does not; no value is echoed. |

### Existing tests corrected (every one is an expectation, not an assertion weakened; reasons recorded in the tests)
| Test | Was stale because | Evidence | Change |
|---|---|---|---|
| `tests/http-auth.test.ts` "membership rules are enforced from the live database" | Expected the pre-Phase-2 rule "two active memberships are refused (403)". Phase 2 (approved) makes that case answer **409 `ACADEMY_SELECTION_REQUIRED`**. | Found by the first FULL suite run (the Phase 2 gap I disclose in `KNOWN_RISKS_AND_REMAINING_ISSUES.md`). `multi-academy-selection.test.ts` and `membership-resolution.test.ts` test the same contract. | Asserts 409 + code on identity, bootstrap and training. |
| `tests/helpers/family-oracle.ts` (used by `family-portal-isolation.test.ts` T-RB1) | The frozen pre-5F oracle read the member name directly; Phase 2 shows a member through the academy display-name rule. | statement-text diff in the failure output (`coalesce(display_name, name)`) | Oracle uses the production `shownName` expression; shape and statement count unchanged. |
| `tests/security-config.test.ts` | (a) baseline "correct production configuration" lacked the two storage variables; (b) the start-up hook test expected a **throw**, but the hook now exits with code 1. | The file aborted the first time (the hook called `process.exit`). | Baseline gains both variables; hook test stubs `process.exit` and asserts exit code 1. |
| `tests/account-password.test.ts` | — (extended) | — | `/verify-password` added to the "not reachable" list. |
| `tests/e2e/auth-no-email.spec.ts` | (a) the last step needs a server **without** Google; `next start` loads `.env.local` (real credentials). (b) an unassigned account now lands on `/academies` ("not part of an academy yet", Phase 2), not `/`; the old assertion passed or failed by timing. | Server with the launcher: `google.enabled:false` although `.env.local` holds credentials; spec then passes end to end. A Google-enabled server now fails the spec with an explicit message, not a confusing one. | Precondition `beforeAll`; landing assertion updated. |
| `tests/e2e/auth-ui.spec.ts` (verify-email flow) | Expects the **mail-enabled** configuration ("a new code is on its way"); without a provider the server answers 503 `SIGNUP_UNAVAILABLE` by design. | live `POST /onboarding/resend-verification` → 503 | Skips itself, with the reason, when the server reports password reset disabled. **Not run tonight** (needs a stubbed provider endpoint; a fake-key provider would make an outbound call). |
| `tests/e2e/phase9-auth.spec.ts`, `phase9-family.spec.ts`, `training.spec.ts` | Written for the pre-redesign login: label "Work email" (now "Email address"), error element `p.error[role=alert]` (now `p.auth-banner-error`), "no forgot link" and a hidden Google button (both exist now). | `grep "Work email" src` finds nothing; current login markup | Selectors and expectations updated to the current UI. |

### Documents added
`OVERNIGHT_SECURITY_AUDIT.md`, `OVERNIGHT_REGRESSION_REPORT.md` (this), `PRODUCTION_READINESS_REPORT.md`, `PHASE4_IMPLEMENTATION_BLUEPRINT.md`,
`MIGRATION_0018_EXECUTION_RUNBOOK.md`, `KNOWN_RISKS_AND_REMAINING_ISSUES.md`; a pointer section appended to `RELEASE_PREREQUISITES.md`.

## 2. Final verification results

| Check | Result | Notes |
|---|---|---|
| TypeScript (`npm run typecheck`) | **clean**, exit 0 | run after the last source change |
| Production build (`npm run build`) | **success** (Next 16.4.1, 25 pages) | also type-checks `src`, `scripts` and `tests` |
| ESLint | **not run: the project has no ESLint** | no dependency or configuration exists; not added unasked |
| `npm audit` | **0 vulnerabilities** | production and dev |
| Full suite on PGlite, **before** the fixes above (baseline) | 958 tests: **852 pass, 2 fail, 104 skipped** | the 2 failures are the stale Phase 2 expectations above; the 104 skips are PostgreSQL-only tests (`TEST_POSTGRES_ADMIN_URL not set`) |
| Full suite on PGlite, **final code** (`npm test`, 87 files) | 965 tests: **860 pass, 1 fail, 104 skipped** (34 min) | The 104 skips are the PostgreSQL-only tests (all of which ran in the PG17 and PG18 runs below). The 1 failure is **environmental, not a defect**: `[PGlite] AT-11 rollback guard … missing` died inside a directory copy with Windows `ERROR_NO_SYSTEM_RESOURCES` (errno 1450, "Insufficient system resources exist to complete the requested service") while the machine had under 100 MB of free memory. Re-run alone it passes (`✔`, 155 s); it also passed in the baseline run and in the full PG17 and PG18 runs. An earlier PG17 attempt that I aborted also showed this same test failing at about 91 s while another session's tests and my browser run were competing for memory; I did not capture that attempt's error text, so the identical cause there is an inference. |
| Full PostgreSQL **17** (`npm run test:pg`, the whole curated list, includes migrations 0013–0018, concurrency, multi-academy, invitations, the new IDOR test) | **789 tests, 789 pass, 0 fail, 0 skipped** (55 min) | run on the final source; only the Phase-9 browser spec edits and one document changed afterwards |
| Full PostgreSQL **18** (same curated list) | **789 tests, 789 pass, 0 fail, 0 skipped** (34 min) | run on the final source, after Docker's engine was restarted (see limitations) |
| Browser regression (Playwright, Chrome), **fresh** seeded disposable PostgreSQL 17, final build | **all runnable specs pass** (details below); **1 spec not run** (mail-enabled verify-email flow) | see below | |

### Browser regression detail
All runs are against a **disposable** PostgreSQL (`sportozen_e2e`, loopback only) and the production build, started with
`scripts/e2e-server.ts` (never `.env.local`). The database was recreated and reseeded before this series.

| Pass | Server profile | Specs | Result |
|---|---|---|---|
| 1 | `plain` (no Google, no mail) | every spec except `multi-academy`, `redesign`, `payment-attempts`; the five "disposable instance" specs enabled (`E2E_DISPOSABLE`, `E2E_BASE_URL`) | **88 passed, 1 failed, 4 skipped** (12 min). The failure, `invitations.spec.ts:79`, signed in through the form straight after other specs' sign-ins and met the documented sign-in limit (5 a minute, one shared bucket on a server without `TRUSTED_PROXIES`): the page stayed on `/login?created=1`. |
| 2 | `plain` | `invitations` alone, then `payment-attempts` alone, then `redesign` alone, each after waiting out the sign-in window | **invitations 4/4, payment-attempts 1/1, redesign 2/2 pass** |
| 3 | `plain`, plus the spec's documented precondition (`admin@greenfield.example` also HEAD_COACH at Bluebird) | `multi-academy` | **4/4 pass** |
| 4 | `fake-google` (obviously fake credentials, nothing talks to Google) | `auth-google-initiation` | **3/3 pass**; the same server makes `auth-no-email.spec` refuse to run with its explicit "needs a server WITHOUT Google credentials" message |

Skipped in pass 1 (4): the 3 Google-initiation tests (they need Google credentials; run in pass 4) and the verify-email flow in `auth-ui.spec.ts` (needs a mail-enabled
server; **not run tonight**). `auth-no-email.spec.ts` passes end to end on the `plain` server (pass 1), independent of `.env.local`.

Things that look like failures but are properties of the browser specs, not of the application (documented so they are not mistaken for regressions):
* Specs that sign in through the form do not wait out the sign-in rate limit; running several back to back can produce `Too many attempts`. Run them apart or with a pause.
* `redesign.spec.ts` "redesigned operational panels" is **not re-runnable on the same database** (a second run saves the identical report summary, so "Save draft" stays disabled); it passes on a fresh database.
* `monthly-report.spec.ts` ("nothing earlier") and `rc5-guardian-access.spec.ts` expect a fresh seed; on a database that already ran them they fail on leftover state. This is why the series above uses a freshly seeded database.
* `multi-academy.spec.ts` needs the dual membership above and **must not** share a database with specs that use `admin@greenfield.example`, which becomes a two-academy account.
* `training-draft.spec.ts` "Closing the tab…" failed once with `browserContext.close: Test ended` while the machine was starved of memory; it passed in pass 1 on the fresh database.

## 3. Regression and architecture review (what was examined, what was found)

Depth is stated honestly: **deep** = code read and exercised; **structural** = checked for authorization, tenant scoping, transactions
and test presence by scans and reading entry points, but business arithmetic was not re-derived.

| Area | Depth | Result |
|---|---|---|
| Identity, sessions, password reset, MFA, Google | deep | S-1, S-2 fixed; S-3 investigated; rest verified (`OVERNIGHT_SECURITY_AUDIT.md`). |
| Multi-academy resolution and switching | deep | No defect. New test for the strongest cross-academy case. Phase 2's two stale tests found. |
| Invitations (Phase 3) | deep (re-read in full) | No defect found in acceptance, expiry, replay, revocation, concurrency, guardian consent. Design limits: S-3, S-8, S-10. |
| Memberships, settings, owner steps | structural + targeted | Every write goes through `requireCapability` and the academy lock; the owner reset refuses owner and multi-academy targets. |
| Players, guardians, consent | structural | All 51 academy write actions authorize at entry (scan); `players/consent` delegates to the consent module after the family check; extensive existing tests. |
| Training, calendar | structural | Transaction sites listed (above); training route body-size finding S-7. |
| Attendance | structural (limited) | There is no separate attendance module; it lives in the session/roster structures covered by the same scoping and tests. Not examined line by line. |
| Fees, invoices, payments, refunds | structural | Authorization at entry, tenant scope, idempotency keys and currency/payment-reference integrity are covered by existing suites (`currency-integrity`, `payment-attempts`, `operations`). Arithmetic not re-derived. |
| Monthly reports and PDFs | structural | Scoped and authorized; covered by `monthly-report.test.ts` and the browser spec. |
| Security events, audit | deep for identity and invitations | Allow-listed detail keys; hash-chained operator log reviewed for the Phase 4 plan. |
| Platform administration | n/a | **Does not exist**: there is no platform actor (blueprint §B). |

**Tenant scoping scan:** of every query on a table that has `academy_id`, 5 lack an academy filter and all 5 are keyed by user or session
by design. **Authorization scan:** 51 of 51 academy actions begin with an authorization check.
**Transactions:** 21 explicit transaction sites outside the `unit()` / `systemUnit()` helpers (outbox 1, account security 3, academy selection 1, onboarding 5, operator and owner recovery 4, invitations 1, privacy 2, training 4); I read the invitation, selection, reset and recovery ones in full; refusals are recorded after the transaction on purpose so they survive it.
**Dead code (compiler, `--noUnusedLocals`):** 10 diagnostics in `src`, all harmless leftovers (unused imports in `family-portal.tsx` and
`studio.tsx`; `fromAcademy` in `mfa-admin.ts`; `normalizeEmail` in `onboarding.ts`). Left in place.
**Duplicate logic:** body-size limiting exists twice (a streaming limiter in the academy route, a buffer-then-check in the training route: S-7).
**N+1:** no per-row query inside a request path of concern; the loops found are workers (privacy erasure, series expansion) or bounded by a handful of rows (guardians of one player).
**Performance notes (not changed):** (P-1) `sign_in_throttle` has no index on `window_started_at`, and every sign-in attempt runs a housekeeping `DELETE ... WHERE window_started_at < now-24h` (a sequential scan of a table that grows with distinct emails in 24 h; cheap normally, costly under credential stuffing; fix = an index in a future migration). (P-2) Every write takes the academy row lock (correct, serialises one academy's writes). (P-3) Expired `session`, `verification` and `auth_rate_limit` rows are never deleted.

## 4. Not verified / limitations
* A real Google round trip, real email delivery and a real WhatsApp send were not attempted (nothing is sent).
* A PostgreSQL restart under load was not rehearsed (the pool fix is verified at unit level only).
* The mail-enabled browser flow (`auth-ui.spec.ts` verify-email) was not run (needs a stubbed provider endpoint).
* ESLint cannot be run (not installed). No load, fuzz or external penetration test was run.
* Docker Desktop's engine stopped during the night (the machine had about 1.2 GB of free memory and another session was also running `test:pg`);
  the PostgreSQL 18 run and the browser runs that needed the disposable PostgreSQL were interrupted, I restarted Docker Desktop's engine and re-ran
  what was lost. The PG17 run completed before that. See the table above for what finished.
* The Playwright specs write screenshots into the repository folder (`access-history-denied.png`, `privacy-preview.png`) and overwrite the tracked `artifacts/training-*.png`;
  these were already modified before tonight. The two new files were created by tonight's runs.
