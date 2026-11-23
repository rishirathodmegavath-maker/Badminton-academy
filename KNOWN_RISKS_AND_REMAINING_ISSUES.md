# Known risks and remaining issues (2026-11-13)

Everything here is **open**. Nothing is listed as closed unless it was verified (those are in `OVERNIGHT_SECURITY_AUDIT.md` and
`OVERNIGHT_REGRESSION_REPORT.md`). "Needs you" means a decision or an approval is required before work can continue.

## 1. Needs your approval or decision
| # | Item | Why it matters | Where |
|---|---|---|---|
| 1 | **Apply migration 0018 to `.data/development`** | The development server shows errors on Settings → Invitations and `/invite` until it is applied. Prepared and rehearsed on a copy; the actual backup, the stop of the server on port 3100 and `db:migrate` need your yes. | `MIGRATION_0018_EXECUTION_RUNBOOK.md` |
| 2 | **Invitation passcode (second secret, different channel)** | Closes the real weakness of the no-mail launch: the invitation link is the only secret, and addresses are unverified (S-3). Schema change (0019 or 0020) and owner workflow change. | `OVERNIGHT_SECURITY_AUDIT.md` S-3, option A |
| 3 | **Phase 4 (lifecycle, platform administration, bootstrap CLI)** | Not started. Blocks any real launch (no way to create the first academy/Owner). 9 decisions listed. | `PHASE4_IMPLEMENTATION_BLUEPRINT.md` §6 |
| 4 | **Owner authenticator enforcement at launch** (`MFA_ENFORCEMENT=enforce` for OWNER) | The main mitigation for S-3 until the passcode exists. | Blueprint D9 |
| 5 | **Rotate the Google OAuth client secret** | It was pasted into the session transcript. | `PRODUCTION_READINESS_REPORT.md` B6 |
| 6 | **ESLint** | The project has none; adding it is a new dependency and a style decision. | Readiness §3 |
| 7 | **Hosting model, CI, deployment files, backup design** | Nothing exists in the repository. | Readiness §1 B2–B4 |

## 2. Open security and privacy items (none is CRITICAL or HIGH)
* **S-3 (MEDIUM)** squatted addresses / link-only secret — see above.
* **S-5 (MEDIUM, defence in depth)** no Content-Security-Policy; HSTS must be set at the proxy; no readiness endpoint.
* **S-6 (LOW)** sign-up answers `EMAIL_IN_USE` (account enumeration; by design, rate limited).
* **S-7 (LOW)** the training API buffers a chunked request body before checking its size (authenticated callers only).
* **S-8 (LOW)** a pending invitation token lives in `sessionStorage` during the sign-in detour (cleared on use); readable only by injected script, which a CSP (S-5) would make harder.
* **S-9 (LOW)** without `TRUSTED_PROXIES` all clients share one rate-limit bucket per endpoint.
* **S-10 (LOW, privacy)** an invitee's email stays in `academy_invitation` indefinitely; erasure covers one **player** at a time, not accounts. When account erasure is designed it needs a controlled redaction path through the immutability trigger.
* **S-11 (LOW)** anyone who knows an address can pause that account's sign-in for 15 minutes (documented trade-off).
* **Unverified accounts can hold sessions** in the no-mail configuration; password recovery by email and Google linking require a verified address, so they are unaffected, but "who is this person" is only as strong as the owner's own check.
* **Only owners invite**, administrators cannot (they do not hold `members.manage`). Intended, but it surprises people; decide whether an `invitations.manage` capability for ADMIN is wanted (needs an authority-equivalence update and your approval).

## 3. Open reliability and operations items
* A restart of PostgreSQL under load has not been rehearsed (the pool now survives the error; the behaviour end to end is untested).
* No production backup/restore/DR procedure, no health/readiness endpoint, no metrics, no structured logging.
* Expired rows in `session`, `verification` and `auth_rate_limit` are never deleted (slow unbounded growth); scheduled jobs (`privacy:process`, outbox, mail worker) have no scheduler definition.
* Every write takes the academy row lock. Correct and simple; a load test with a busy academy has not been run.
* `.data/` on this machine holds about 90 stale test database folders (`test-*`, `ops-*`, `*-media-*`) from earlier runs. Harmless, but they use disk; they are not tracked by git. I did not delete them (they are outside tonight's scope; list them with `Get-ChildItem .data -Directory` and remove the ones you recognise as test leftovers; **never** `.data/development`).
* **This machine is memory-starved for the full suites** (7.9 GB total; about 100 MB free during the runs). With a second session also running `test:pg`, Docker Desktop's engine stopped during the night, I restarted it, and one PGlite migration test failed with Windows `ERROR_NO_SYSTEM_RESOURCES` (it passes alone). Run the full suites one at a time, or in CI with more memory.
* The browser specs that need a seeded database (`invitations`, `multi-academy`, the Phase 9 set) are run by hand against a disposable server; there is no single command or CI job for them yet. `scripts/e2e-server.ts` (added tonight) is the deterministic way to start that server.

## 4. Quality and process notes (disclosure)
* **Verification gaps I caused in Phase 2, found tonight.** In Phase 2 I did not run the whole `tests/migrations.test.ts` (found and fixed in Phase 3) and I did not run the whole suite. The full run tonight found **two more stale tests** that the Phase 2 change had made wrong, not product bugs:
  `tests/http-auth.test.ts` still expected the old "two memberships are refused (403)" rule (the product now answers 409 `ACADEMY_SELECTION_REQUIRED`, as designed and tested in `multi-academy-selection.test.ts`), and the frozen pre-5F oracle in `tests/helpers/family-oracle.ts` read the member name directly instead of through the academy display-name rule. Both were updated, with the reason in the test, and pass. Lesson recorded in memory: after a schema or behaviour change run the **whole** suite, not the affected files.
* The two changes above edit *expectations*, so they are listed here and in the regression report for you to review; no assertion was loosened beyond what the approved Phase 2 design requires.
* The browser specs `auth-no-email.spec.ts` / `multi-academy.spec.ts` failures reported earlier were environment artefacts (real Google credentials in `.env.local`; a leftover membership in my disposable database). The first is now fixed by the deterministic server launcher (below); neither was a product defect.

## 5. What was changed tonight (so you can review it)
See `OVERNIGHT_REGRESSION_REPORT.md` for the exact file list, tests and results.
