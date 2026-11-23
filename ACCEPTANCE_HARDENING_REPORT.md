# Acceptance hardening: contacts, invitations, automated reports and bulk dispatch (Badminton)

Date: 2026-11-22 (rounds 1 and 2: 2026-11-21). Scope: Badminton only; Football untouched. Nothing was committed, pushed, tagged, merged or deployed. No production
database or production data was touched, no real e-mail or WhatsApp message was sent, no paid service or credential was used.
Round 4 (first) is the browser CI profiles and the test-only email provider; Round 3 is the browser and accessibility remediation; Round 2 (below it) retires the adult-player coverage and fixes one privacy defect; Round 1 (last) is the earlier acceptance report. Evidence folder (kept): `D:\Sportozen\badminton-main-local\acceptance-evidence\` (logs of every run, screenshots, a sample PDF, the scripts; Round 3 logs are named `round3-*`, Round 4 logs `round4-*`).

## Recommendation (updated after round 4)

**Accept round 4's browser CI profiles and the test-only email provider, with the stated limits.** The final complete orchestration executed all 103 planned browser tests across the five profiles (standard 88, dispatch 2, multi-academy 4, google 3, email 6): **103 passed, 0 failed, 0 skipped, 0 did not run**, setup and teardown verified for each, exit code 0. The one test Round 3 could not run now runs, with five more around it (verification, wrong and expired codes, reset, tampered and expired links, recipients). No real e-mail was sent: no mail credential on any server, 0 attempts to a mail or messaging host. Round 3's privacy and accessibility fixes are intact (same files, contrast 28/28, the privacy regression tests pass on both databases). **Read the limits before calling it done:** it is one green complete run after one run with a failure (a genuine race in the Reports screen that the spec triggered; the screen is not fixed, and a small separate fix is recommended); the `dispatch` and `email` profiles run a development server because their test adapters refuse production; the orchestrator was run from an isolated copy against a local PostgreSQL, not wired into a hosted CI service; and the test provider proves the application's side only, not a real provider. **This is not a statement of production readiness.**

## Recommendation after round 3 (superseded by round 4 above; kept for the record)

**Accept round 3's fixes.** Typecheck is clean, the contrast checker reports no failing colour, the relevant unit tests pass 175 of 175 on both the embedded database and PostgreSQL (the adult-profile privacy regression included), and the five requested items are fixed. **The browser acceptance criteria are met only with a stated split, not as one unattended command.** On a production build, one complete `playwright test` run ends **91 passed, 3 failed, 4 skipped of 98 (14.2 minutes)**, reproduced twice. The 3 failures need a configuration the single run does not provide (a development-mode server with the test delivery adapter; an extra membership fixture); in their own configuration they pass (dispatch 2/2, multi-academy 4/4), and the 3 Google-initiation skips pass 3/3 on the project's fake-credentials profile. One test (`auth-ui` "Verify email 6-digit flow and Reset password", needs a transactional e-mail provider) was not run at all. **Not a statement of production readiness**: see R3.7.

## Recommendation after round 2 (superseded by round 3 above; kept for the record)

**Accept the adult-player retirement and the privacy fix.** Unit tests (embedded database) pass 920 of 920 and the PostgreSQL pass has 0 failures in 70
files; typecheck is clean; the seed no longer creates an adult. **Do not treat the browser suite as passing.** Run on a development server on this
8 GB machine it ended 73 passed, 13 failed, 12 skipped; the failures are classified below (stale specs, an accessibility defect, a test timing
race, and slowness or rate limiting), none of them traced to this round's changes, but the browser suite has no earlier complete baseline, so
"none introduced by this round" rests on per-failure evidence, not on a before/after comparison. **This is not a statement of production
readiness**: no production or staging environment exists, no real provider was contacted, and the gaps in "Remaining limitations" stand.

# Round 4: browser CI profiles and a test-only email provider

Task (product-owner approved): (1) separate, explicit CI server profiles for the configuration-dependent browser tests; (2) a deterministic, test-only email provider for the one browser test that Round 3 could not run (email verification / password reset). Then run every profile on its own, run the complete orchestration, and report honestly. Date: 2026-11-22. Scope: Badminton only; Football, ports 3200 and 3300, `.env.local`, production and staging were not touched. Nothing was committed, pushed, tagged, merged, migrated or deployed. No real e-mail or WhatsApp message was sent (R4.7).

## R4.1 Result

**The final complete orchestration (`round4-full2`) ran all five profiles, each on its own fresh database and its own server, and executed 103 planned tests: 103 passed, 0 failed, 0 skipped, 0 did not run. Setup and teardown were verified for every profile. Exit code 0.** Round 3's single run was 91 passed / 3 failed / 4 skipped of 98, with one e-mail test never run; the 98 tests are all in this run, plus 5 new e-mail tests (the stub made them possible).

| Profile | Server | Planned | Passed | Failed | Skipped | Did not run | Seconds | Teardown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| standard | production build, plain | 88 (19 spec files) | 88 | 0 | 0 | 0 | 669 | verified |
| dispatch | development, delivery test adapters | 2 | 2 | 0 | 0 | 0 | 106 | verified |
| multi-academy | production build, Bluebird head-coach fixture | 4 | 4 | 0 | 0 | 0 | 25 | verified |
| google | production build, obviously fake Google credentials | 3 | 3 | 0 | 0 | 0 | 16 | verified |
| email | development, test authentication-email provider | 6 | 6 | 0 | 0 | 0 | 113 | verified |
| **Total** | | **103** | **103** | **0** | **0** | **0** | 929 (15.5 min) | |

**Two things that this table does not say on its own, and that a reviewer should weigh:**

1. It is the **second** complete run. The first complete run (`round4-full`) ended **102 passed, 1 failed** (a `dispatch` test, explained in R4.5 item 4: a genuine race in the Reports screen that the spec triggered; the spec was changed, the application was not). The final run is green; I ran it once, so the **frequency** of any remaining timing-sensitive failure is not measured.
2. The two development-mode profiles (`dispatch`, `email`) run the **development** server, because the test adapters and the test provider refuse to run in production by design. Those 8 tests therefore exercise development-mode builds, not the production build.

## R4.2 The profiles (`scripts/lib/e2e-profiles.ts`, run by `scripts/e2e-ci.ts`)

Each profile declares its mode, Google setting, test capabilities, fixtures, the environment its specs must be given, its own port and its specs. A unit test pins that **every spec file belongs to exactly one profile** (a new, unlisted spec fails `tests/e2e-profiles.test.ts` instead of silently not running), that no profile can enable a test-only capability in production mode, that no profile uses ports 3100/3200/3300, and that no spec still skips itself on a missing server configuration.

| Profile | Mode | Port | Configuration | Fixtures | Specs |
| --- | --- | --- | --- | --- | --- |
| standard | production | 3410 | no Google, no mail provider, no delivery adapters | none | 19 files (all that need nothing special) |
| dispatch | development | 3411 | `DISPATCH_EMAIL_PROVIDER` / `DISPATCH_WHATSAPP_PROVIDER` = test, outbox file | none | `dispatch-reports` |
| multi-academy | production | 3412 | plain | `owner-at-bluebird` | `multi-academy` |
| google | production | 3413 | fake Google client id and secret; the redirect is intercepted, nothing reaches Google | none | `auth-google-initiation` |
| email | development | 3414 | `EMAIL_PROVIDER=test`, `AUTH_EMAIL_CAPTURE_FILE`, `E2E_DISPOSABLE=true` | none | `auth-email-flows` |

How it is run (the orchestrator creates its own database; it refuses anything but a loopback PostgreSQL and never reads `.env.local`):

```
E2E_ADMIN_URL=postgres://<user>:<password>@127.0.0.1:<port>/postgres  npm run test:e2e:ci -- [--profile standard,email] [--build] [--out <dir>] [--list]
```

Per profile it: drops and recreates the database `sportozen_e2e`, migrates and seeds it, applies the fixtures, starts the server on the profile's port with an environment built from scratch by `scripts/lib/e2e-server-env.ts` (nothing is inherited from the parent environment; unsafe or relative paths and combinations are refused), waits for the server on a condition (never a fixed delay), runs only that profile's specs with `playwright.ci.config.ts` (retries 0, `forbidOnly`, one worker), then tears down and **checks** each teardown step (fixtures removed and no longer present, server process tree stopped and the port closed, temporary files removed, database dropped). A skip, a failure, a test that did not run, a planned count that differs from the executed one, or a teardown step that cannot be verified each make the run "NOT GREEN" and the exit code non-zero. A missing configuration is a failure, not a skip: the first attempt of this round (PostgreSQL not yet started) ended "teardown NOT VERIFIED", exit 1, as designed.

Not weakened: the production security configuration (the production profiles use the unchanged production start path and the production config check), the sign-in rate limit (5 a minute per client; the specs use cached role sessions, and the email spec signs in three times in total), cookies and headers. The browser tests use no arbitrary waits; every synchronisation is on the screen, the capture file or the database (R4.5 lists the three places where a missing synchronisation was found and fixed).

## R4.3 The test email provider

`EMAIL_PROVIDER=test` adds a third provider beside `resend` and `zeptomail`. It appends each message the app would send (kind, recipient, subject, text with the code or reset link, idempotency key) as one JSON line to a local file and returns success; nothing leaves the machine and it prints nothing. The app's real path is unchanged up to the provider: the onboarding endpoint queues the mail in `auth_email_outbox`, the payload is sealed with AES-GCM, the outbox worker opens it and hands it to the provider, and the sealed secret is wiped from the database once the message is "sent" (the spec asserts it).

**Only enabled in a disposable test environment** (all of these must hold, or the configuration is invalid and the provider is not created):

| Requirement | Enforced where | What happens otherwise |
| --- | --- | --- |
| `NODE_ENV` is not `production` | `emailProviderConfig` (config parser), the `TestAuthEmailProvider` constructor | configuration invalid; `checkSecurityConfig` reports an **error** and the app refuses to start; the class throws if built anyway |
| `E2E_DISPOSABLE=true` | both | same |
| `AUTH_EMAIL_CAPTURE_FILE` is an absolute path without control characters | both | same |
| no `RESEND_API_KEY` and no `ZEPTOMAIL_TOKEN` in the same environment | the config parser | same: test credentials and real credentials cannot meet |

Messages name settings, never values. When the provider is active in a non-production process the startup check adds a **warning** ("authentication emails are written to a local capture file and nothing is sent; disposable test instances only"). The orchestrator builds the server environment itself, so only the `email` profile has `EMAIL_PROVIDER`, the capture file and `E2E_DISPOSABLE`; the production-mode profiles carry none of them whatever the parent environment says (unit-tested).

**Secrets and logs.** Codes and links exist in the capture file and in the sealed outbox row only. After the `email` profile the orchestrator scanned the server's logs for every captured code and token: **0 occurrences** (6 messages captured: 3 verification codes, 3 reset links). The capture file is created with mode 0600 and removed at teardown. The fixture accounts are fictional (`@example.test`).

**What the new browser spec `tests/e2e/auth-email-flows.spec.ts` proves (6 tests, all executed and passed):** the moved Round-3 UI test (validation, responsive layout, accessibility of the verify and reset screens); a verification code is mailed, a wrong code is refused with the generic words, the right code with a password verifies the account and the account then signs in (and the planted password no longer does); an **expired** code is refused with the same words as a wrong one, the account stays unverified and a new code recovers it; a reset link is mailed, opens the form (token in the fragment, removed from the address bar), sets a new password, works once, and the old password stops working; a **tampered** link and an **expired** link are refused, offer a new link and change nothing; and a final test that every message the app tried to send went to an account the spec planted (or the one seeded account the UI test asks a reset for) and only into the capture file. Expiry is produced by moving the expiry in the disposable database, not by waiting.

## R4.4 Files changed in Round 4 (all under `D:\Sportozen\sportozen-badminton-main`; 26 files; nothing deleted; no UI view or stylesheet changed)

Application source (5): `src/infrastructure/email/provider.ts` (test provider config and the refusals above), `src/infrastructure/email/test-provider.ts` (new), `src/infrastructure/email/index.ts` (exports and factory branch), `src/modules/identity/email-delivery.ts` (the test provider counts as configured), `src/modules/identity/security-config.ts` (warning when the test provider is active).

Browser CI (new): `scripts/e2e-ci.ts`, `scripts/lib/e2e-profiles.ts`, `scripts/lib/e2e-fixtures.ts`, `scripts/lib/outbound-guard.cjs`, `playwright.ci.config.ts`, `tests/e2e/support/profile.ts`, `tests/e2e/support/database.ts`, `tests/e2e/support/batch-view.ts`, `tests/e2e/auth-email-flows.spec.ts`. Changed: `scripts/lib/e2e-server-env.ts` (development mode, delivery and email test capabilities, outbound guard, refusals), `package.json` (`test:e2e:ci`), `tests/e2e/support/roles.ts` (`E2E_AUTH_CACHE_DIR`), `tests/e2e/dispatch-reports.spec.ts`, `auth-google-initiation.spec.ts`, `multi-academy.spec.ts`, `invitations.spec.ts` (declared configuration instead of silent skips), `auth-ui.spec.ts` (the e-mail test moved to `auth-email-flows.spec.ts`), `batch-reports.spec.ts` (helper, R4.5 item 4).

Unit tests: `tests/email-test-provider.test.ts` (new), `tests/e2e-profiles.test.ts` (new), `tests/e2e-server-env.test.ts` (extended).

The outbound guard (`scripts/lib/outbound-guard.cjs`, preloaded with `--require` into every profile server) wraps Node's `fetch` and socket connects: it refuses any non-loopback host and records the attempt. It guards the **server process**, not the browser, and not a child process that clears `NODE_OPTIONS`.

## R4.5 Defects found while verifying (what each was, and whether the application changed)

1. **Test fixture bug (mine).** The e-mail spec planted its account with `auth_account.account_id` set to a random id, not the user id that Better Auth and the app always use; the stored hash was correct (checked with `verifyPassword`) but sign-in returned 401. Fixed in the spec. Application unchanged.
2. **Test navigation bug (mine).** The tampered link and the expired link differ only in their `#fragment`, so the second `goto` was a same-document navigation and the page kept the "link invalid" state of the first attempt. Each attempt now uses a fresh page.
3. **Missing synchronisation (mine).** The reset and forgot-password buttons stay disabled until React has attached its handlers; the spec filled the form before that and hydration cleared it. The spec now waits for the button to be enabled (the same pattern the sign-in helper already used). No fixed waits.
4. **Genuine race in the application's Reports screen, not fixed (out of scope).** In `src/modules/academy/ui/views/batch-reports.tsx` the rows are kept with the batch and month they were loaded for; a response for an earlier choice that arrives after the response for the later one replaces it, the rows no longer match the current choice, and the section stays on "Loading…". A person who changes the batch and the month within milliseconds can hit it. It was the cause of the one failure in the first complete run (`dispatch`: the "test mode" notice never appeared; the trace shows the section stuck on "Loading…"). Diagnosed from the code and the trace; **I did not reproduce it in isolation**, and I did not change the application because that is a workflow change outside this task. The specs now choose the batch and the month one at a time, waiting on the screen for each load (`tests/e2e/support/batch-view.ts`, used in `batch-reports` and `dispatch-reports`). **Recommendation: a small fix in the view (ignore a response whose key is no longer the current one) as a separate, reviewed change.**

## R4.6 Verification: commands and actual results

All browser and unit runs were done in an **isolated copy** of the project (`D:\Sportozen\_tmp-bm-r4\proj`, no `.env*`, no build output, byte-identical to the project for `src`, `scripts` and `tests`, checked with `diff -rq` before the final runs) against a **disposable PostgreSQL 17 on 127.0.0.1** with a random password and a throw-away data folder, because the project folder has a development server on port 3300 that holds the development build folder. The orchestrator was therefore not run from inside the project folder itself.

| Check | Result | Evidence (in `acceptance-evidence\`) |
| --- | --- | --- |
| Each profile on its own (first independent runs) | google 3/3; standard 88/88 (12.8 min); multi-academy 4/4; dispatch 2/2; email: first run 1 passed, 1 failed, 4 skipped (defects 1 to 3 above), after the fixes **6/6** | `round4-p-google`, `round4-p-standard`, `round4-p-multi`, `round4-p-dispatch`, `round4-p-email` to `round4-p-email4` (each with `-console.log`) |
| Complete orchestration, first | 102 passed, 1 failed (R4.5 item 4) | `round4-full` |
| **Complete orchestration, final** | **103 planned, 103 passed, 0 failed, 0 skipped, 0 did not run; teardown verified on all five** | `round4-full2` (`results.json`, per-profile logs) |
| Typecheck (`tsc --noEmit`, includes tests) | clean, run after the last edit | |
| Contrast (`npm run check:contrast`) | 28/28 pass, 0 literal text colours under 4.5:1 | |
| Unit tests, embedded database: the 13 files for the touched modules (`email-test-provider`, `e2e-profiles`, `e2e-server-env`, `security-config`, `auth-without-email-provider`, `comms-config-fallback`, `zeptomail-email`, `zeptomail-onboarding-http`, `onboarding-http`, `auth-email-outbox`, `auth-forms-static`, `google-signin`, `google-signup`) and the 19 Round-3 files | 289 tests: 287 pass, 0 fail, 2 skipped (the two outbox tests that need PostgreSQL: "`TEST_POSTGRES_ADMIN_URL` not set") | `round4-unit-embedded.log` |
| The same 32 files on PostgreSQL 17 | **289 tests: 289 pass, 0 fail, 0 skipped** (the two outbox tests ran) | `round4-unit-postgres.log` |

Not re-run in Round 4: the full unit suite (Round 2 baseline: embedded 1,046 tests / 920 pass; PostgreSQL 840 tests / 832 pass). Round 4 changed five files under `src`, all in the e-mail provider and the startup check, and the 13 touched-module test files above exercise them.

## R4.7 No real e-mail was sent

- Every server ran with **no mail credential** (`RESEND_API_KEY` and `ZEPTOMAIL_TOKEN` empty, checked on each of the five servers by the orchestrator: `serverMailCredentialsPresent: false`).
- The outbound guard recorded **0 attempts** on `standard`, `multi-academy` and `google`, and **2 attempts each on `dispatch` and `email`, all to `registry.npmjs.org`** (the development server's own package-version check, refused by the guard). **0 attempts to any mail or messaging host** on every profile.
- The `email` profile server ran with `EMAIL_PROVIDER=test`; every message the app composed ended up only in the capture file (6 messages, 3 verification codes and 3 reset links, all to fictional addresses and to the one seeded account the UI test asks a reset for), and the last test of the spec asserts that no other recipient exists.
- The `dispatch` profile's messages (reports to families) were recorded in its own outbox file by the delivery test adapters; none were sent. Both test adapters and the test e-mail provider refuse production.

## R4.8 Setup and teardown, as verified by the orchestrator (`results.json`)

For all five profiles in `round4-full2`: database "created empty", migrated, seeded, server ready; after the specs: fixtures removed and **none still present** (`multi-academy`: `owner-at-bluebird` applied before and removed after), server stopped, port closed, database dropped, temporary files removed. At the end of the round I also stopped only my own PostgreSQL (port 5545) and removed the isolated copy and the throw-away data folders; the servers on 3200 and 3300 were not touched and still answered.

## R4.9 Round 3's fixes are intact

- Privacy: the adult-profile protection (`ADULT_RECORD_PROTECTED` in `src/modules/players/application/service.ts`) is untouched (file byte-identical to Round 3); `legacy-adult-profile`, `guardian-access-domain`, `privacy`, `cross-academy`, `dual-academy-idor`, `family-portal-isolation` and `dispatch-authorization` pass on both databases (above).
- Accessibility: `src/app/redesign.css` and every view are untouched (byte-identical); the contrast checker still reports 28/28 and 0 literal failures; `phase9-a11y` (16 tests) is in the `standard` profile and passed (88/88).
- The five Round-3 items and the Round-3 spec fixes are all in the 103-test run that passed.

## R4.10 Remaining unexecuted tests, limitations and what this does not claim

- **Unexecuted planned tests: none** in the final complete run (0 skipped, 0 did not run). The full unit suite was not re-run (see R4.6).
- **One green complete run after one run with a failure.** Stability over repeated runs was not measured. The standard profile alone takes about 11 to 13 minutes on this 8 GB machine.
- The `dispatch` and `email` profiles run the **development** server (see R4.1); production-build behaviour of those 8 tests is not covered.
- The test provider proves the application's side of the e-mail flows (queueing, sealing, the code and link contents, expiry, single use, rate limits). It does **not** prove deliverability, spam handling or the behaviour of a real provider (Resend, ZeptoMail): no real provider was contacted. Those remain gaps as in Rounds 1 and 2.
- The Reports-screen race (R4.5 item 4) is open in the application. The outbound guard covers the server process only. The orchestrator was run on Windows only, from an isolated copy, against a local PostgreSQL; wiring it into a hosted CI service (a PostgreSQL service, the build step, artefact upload) is not done and was not asked for.
- Nothing here is a statement of production readiness: no production or staging environment exists, no real provider was used, and the gaps in "Remaining limitations" of Rounds 1 and 2 stand.

# Round 3: browser and accessibility remediation

Task: fix the browser-test and accessibility issues Round 2 listed (four stale assertions, the duplicate test title, the `.set-counter` contrast, the invoice-button accessible name, the `phase9-family` timing race), run the affected specs singly and the complete suite on a production build, and report honestly.

## R3.1 Where the browser tests ran

- **Production build, isolated.** A copy of the project (no `.env*`, no `.data`, no build output) in `D:\Sportozen\_tmp-bm-e2e`, built with the project's own `next build` (Turbopack), served by the project's own launcher `scripts/e2e-server.ts` (`NODE_ENV=production`, `.env.local` never read) on **port 3310**, against a **disposable native PostgreSQL 17** (`127.0.0.1:5545`, database `sportozen_e2e`, random password, throw-away data folder), migrated and seeded with the project's seed scripts. Chrome (channel `chrome`), one worker.
- Two further disposable servers, for the tests that need them: port **3311** (production, the project's `fake-google` profile: obviously fake credentials, nothing talks to Google) and port **3312** (development mode, `DISPATCH_*_PROVIDER=test`, so nothing leaves the computer).
- Ports **3200 and 3300 were not touched** (both answered throughout: 3300 `200`, 3200 `307`). I stopped only my own 3310, 3311 and 3312 servers. The machine had 1.1 GB free RAM with both live servers running; the build ran at below-normal priority with a capped heap and took about 54 seconds to 2 minutes.
- All disposable servers, the PostgreSQL instance and the copy were removed at the end (R3.8). The project tree was edited only in the files listed in R3.8; every test run happened in the copy, so no `test-results` or output was written into the project.

## R3.2 The five requested items: stale test or genuine defect, and the fix

| # | Item | Finding | Fix |
| --- | --- | --- | --- |
| 1a | `monthly-report` "Coach: numbered workflow…" | **Stale test.** It expected the sheet to read "2 of 3 sessions · 67%". The player header shows `2 / 3` and `67% attendance`, the progress table "2 of 3 sessions (67%)"; that markup is identical to the pre-round snapshot (`ux-audit/wave-0-snapshots`). | Asserts the three real elements (`.rs-attendance strong` = `2 / 3`, `small` = `67% attendance`, progress table contains `2 of 3 sessions (67%)`). Nothing weakened: every fact is still checked, against where it is actually shown. |
| 1b | `monthly-report` "Approval and publication…" | **Stale test.** It looked for the screen's `2 / 3` in the PDF text; the PDF tiles read "2" then "of 3" and "67%". The PDF layout is unchanged from the snapshot. | The test reads count and percentage from the screen and requires `"<attended> of <total>"` and the percentage in the PDF. |
| 1c | `redesign` ×2 | **Round 2 misdiagnosed these** (it blamed a `.reference-view` class that "only some modules render"; every module does render it, and the specs pass that step on the production build). The slow development server had hidden the real causes, which are below. | See 1d to 1h. |
| 1d | `redesign` test 1, Communications step | **Stale test.** The composer was redesigned: an audience radio, a "Players' parents" list shown for the chosen-audience option, and an automatic recipient check (no "Preview authorised recipients" button). | The test chooses the radio, picks the player, and asserts the heading `N family/families will receive this`. |
| 1e | `redesign` test 1, Reports step | **Test depended on state.** It typed the same fixed summary on whichever report opened first; once saved by an earlier run the draft already equalled it, nothing was "unsaved" and Save draft was (correctly) disabled. It also assumed its own report opens first (a published report is read-only). | A summary unique to the run, and the test selects the report it created. |
| 1f | `redesign` test 2, Settings width check | **Genuine application defect.** At 820 and 1180 px the Settings page scrolled sideways (`scrollWidth` 1004 and 2171). Cause: `.reference-view input { width:100%; padding:10px; border }` out-ranks `.sr-only` (1px), so the hidden "Choose academy PNG logo" file input became viewport-wide and sat past the right edge. | `redesign.css`: `.reference-view input.sr-only { width:1px; height:1px; margin:-1px; padding:0; border:0 }`. Measured after: `scrollWidth` equals the window width at 375, 820 and 1180 px. |
| 1g | `redesign` test 2, enquiry notes | **Test race.** Saving reloads the enquiry and the panel returns to its Details tab; the test reopened "Notes & feedback" before that and the reload reset it. | Waits for the Details-only button before reopening the tab. |
| 1h | `redesign`, sign-in | Signed in directly each time (rate-limited, R3.4). | Uses the shared cached session (R3.4). |
| 2 | Duplicate test title in `phase9-a11y.spec.ts` | **Stale duplicate.** The second "Settings tabs (owner)…" test walked the old flat tab list. Every screen it visited is covered by the first (grouped) test: Branding, Regional settings, Modules, Plan in "Academy"; Branches & batches in "Sessions"; Roles & permissions, Invitations in "Team"; Policies, Consent documents, Privacy and erasure; Two-factor policy, Security events, Access history, Audit history; Integrations and Subscription in "Integrations". | The stale copy is removed from the project's own file (the file now loads without the disposable-copy workaround Round 2 needed). No coverage lost. |
| 3 | `.set-counter` contrast | **Genuine defect** (one literal colour `#6b7a90`). | `color: var(--text-muted)`, the design system's own token, no new colour. **Numbers (WCAG formula):** old 4.36:1 on white (the project checker's 4.06:1 is against its darkest light surface), both under 4.5:1; **new `#536276` 6.22:1 on white, 5.78:1 on the page background.** `npm run check:contrast`: 28/28 token pairs pass, **0** literal colours under 4.5:1 (was 1). axe: the `color-contrast` finding on `/settings` is gone (`phase9-a11y` 16/16). |
| 4 | Invoice select buttons on `/fees` | **Genuine defect** (WCAG 2.5.3, label in name): `aria-label="Select invoice INV-…"` replaced the visible player name. A first attempt (label starting with the name) still failed: axe compares with the button's visible text *including* the aria-hidden initials ("AM Aarav Mehta"). | The `aria-label` is removed; the name comes from content: the visible player name plus a visually hidden ", select invoice INV-…" (two invoices of one player stay distinguishable). **Verified in the browser:** computed name `"Aarav Mehta , select invoice INV-EEF80466"`, no `aria-label`, axe `label-content-name-mismatch` **0 violations**; `phase9-a11y` "Owner" and "FINANCE /fees" pass. The three specs that look the button up by "Select invoice INV-…" still match (case-insensitive substring) and pass. |
| 5 | `phase9-family` sign-in race | **Test race, root cause found.** The app keeps "Sign in" disabled until React has hydrated (`useHydrated`); text typed before that is not in the form's state, so the click submitted empty fields, client validation blocked it and no request was sent (`waitForResponse` timed out). | The test waits for the button to be **enabled** (the page's own readiness signal) before typing. No fixed delay. 6/6 pass. |

## R3.3 Other defects found while doing this

- **Genuine application defect: a report's session list was in database order.** `reports/application/draft.ts` built the evidence from a `SELECT` with no `ORDER BY`, so "Recorded sessions" (screen, PDF) and `evidence[]` could appear in any order. The same `monthly-report` test passed in one run and saw `PRESENT, ABSENT, PRESENT` in another. **Fix:** the snapshot is sorted by date, then title, then id; the sheet also sorts older stored drafts by date (stable). **Regression test:** `tests/monthly-report.test.ts` "a draft lists its sessions in the order they happened…" (sessions recorded newest-first in a separate month, plus a shuffled stored draft). **Proved it fails without the fix** (`round3-ordering-without-fix.log`: the 20th appears first; 7 other tests pass) **and passes with it** (8/8, `round3-ordering-with-fix.log`).
- **Test isolation faults (each made a spec pass once per database, or fail by collision):** (a) `monthly-report`, `batch-reports` and `dispatch-reports` each picked a random 2027 month of 11, so two specs often used the same month and the report counted 5 sessions instead of 3. They now ask the server for the first unused month from 2030 (`support/months.ts`, new). (b) `monthly-report` published a fixed sentence and then asserted the family could not yet see it: on a second run it already could. The sentence is unique per run. (c) `dispatch-reports` test 2 saved academy rules (required category "Behaviour and discipline") and never put them back, so test 1 on the next run had every report blocked (`CATEGORY_MISSING`). It now restores the rules and asserts they are restored; the save waits on the `policy-save` response (the earlier `getByText("Saved.")` also matched the unrelated "Changes saved." toast and passed instantly). (d) `dispatch-reports` test 1 read the whole test-adapter outbox file, which outlives the database, so earlier runs' messages counted; it now reads from its own starting point.

## R3.4 Rate-limit failures and navigation instability, investigated separately

- **The limiter** (`auth.ts`): `/sign-in/email` allows **5 attempts per 60 s per client address**, stored in the database. With no `TRUSTED_PROXIES` (as on any test server) every client shares one bucket. The tests' own comments say the limit is not weakened for tests, and I did not change it. The failures were specs that signed in directly (`coach-handover`, `payment-attempts`, `privacy`, `redesign` ×2), spending the bucket in a long run. They now use `support/roles.ts`, which signs each role in once, caches the session and waits out a 429. The first complete production run (before this change) still had one 429 failure (`coach-handover`); in the two complete runs after it **no test failed on a 429**. (I hit the limit myself three times with ad-hoc probe scripts and waited it out, which is the same behaviour.)
- **Navigation instability** (`phase9-navigation` failing at a different step each run, `phase9-responsive` 10-minute timeout, `phase9-auth`): **a property of the development server on this machine** (compiling each route on first visit under memory pressure), not of the application. On the production build `phase9-navigation`, `phase9-responsive`, `phase9-auth` and `phase9-a11y` all pass in the complete runs, with no pause between spec files.
- **Rate-limited sign-in in the app itself is unchanged and still tested** (`phase9-auth` "Wrong password…").

## R3.5 Verification: commands and actual results

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `node node_modules/typescript/bin/tsc --noEmit --incremental false` (= `npm run typecheck`; includes tests) | **clean, exit 0** (run after the last edit) |
| Contrast | `npm run check:contrast` | 28/28 pass, **0** literal colours under 4.5:1 |
| Lint | none exists (no script, dependency or config) | unchanged from Round 2 |
| Relevant unit tests, one file at a time, **embedded** database | `tsx --test tests/<file>.test.ts` for `monthly-report`, `report-sheet`, `report-progress`, `report-engine`, `report-batch`, `operations`, `legacy-adult-profile`, `guardian-access-domain`, `dispatch-authorization`, `family-portal-isolation`, `cross-academy`, `dual-academy-idor`, `privacy`, `rc2-static-gates`, `authority-equivalence`, `role-payload`, `auth-endpoint-surface`, `invitations-http`, `calendar-series` | **19 files, 175 tests, 175 pass, 0 fail, 0 skipped** (`round3-unit-embedded-*.log`) |
| Same files on **PostgreSQL 17** | same, with `TEST_POSTGRES_ADMIN_URL` | **19 files, 175 tests, 175 pass, 0 fail, 0 skipped** (`round3-unit-postgres-*.log`) |
| Affected browser specs, singly | `redesign` 2/2, `phase9-a11y` 16/16, `phase9-family` 6/6, `payment-attempts` 1/1, `monthly-report` 5/5 (production server) | all pass (`round3-browser-affected2.log`, `round3-browser-monthly-report.log`). `monthly-report` ran 5/5 on a fresh database; a second run on the same database failed once on the fixed published sentence (R3.3 b), which is why it is now unique per run, and it passes in both later complete runs. |
| **Complete browser suite, production build** | `playwright test -c playwright.isolated.config.ts tests/e2e` with `testMatch` widened to every spec in the copy | see below |

(The full unit and PostgreSQL suites of Round 2 were not re-run: this round changed `draft.ts` and `report-sheet.ts` in the reports module and nothing else under `src` besides one stylesheet rule and one view; the 19 files above cover reports, the privacy and authorization guards and the repository guard tests. Round 2 baseline: embedded 1,046 tests / 920 pass; PostgreSQL 70 files / 840 tests / 832 pass.)

**Complete suite, same 98 tests, three states:**

| Run | Passed | Failed | Skipped | Time |
| --- | --- | --- | --- | --- |
| Round 2, development server | 73 | 13 | 12 | 1.1 h |
| Round 3, production build, before the spec fixes (`round3-browser-full-prod.log`) | 87 | 7 | 4 | 14.0 min |
| Round 3, production build, after the spec fixes (`round3-browser-full-prod-2.log`) | 91 | 3 | 4 | 13.1 min |
| **Round 3, final, pristine database, the project's exact specs** (`round3-browser-final-prod.log`) | **91** | **3** | **4** | **14.2 min** |

**The 3 remaining failures** (identical in both complete runs after the fixes) **and the 4 skips, each with its own result:**

| Test | Why it cannot pass in the single production run | Result in the configuration it needs |
| --- | --- | --- |
| `dispatch-reports` "owner: choose recipients, preview, record an opt-in…" | expects the banner "test mode: nothing leaves this computer"; the test delivery adapter **refuses to run in production** by design (`test-adapter.ts`) | **passes** with its test 2: **2/2** on a pristine database, development-mode server, test adapter (`round3-browser-dispatch-dev-fresh2.log`) |
| `multi-academy` "several academies…" and "the chooser needs a signed-in person…" | the spec's header requires the seeded Greenfield owner to **also hold a head-coach membership at Bluebird**; no seed script creates it, and it would send every other spec's owner to the academy chooser | **4/4 pass** with that membership added to the disposable database for the run and removed afterwards (`round3-browser-multi-academy-fixture.log`) |
| `auth-google-initiation` ×3 (skipped) | need a server with Google credentials | **3/3 pass** on the project's `fake-google` server profile (`round3-browser-google-initiation.log`) |
| `auth-ui` "Verify email 6-digit flow and Reset password UI…" (skipped) | needs a server with a transactional e-mail provider ("stubbed endpoint") | **not run**; I did not build a stub e-mail endpoint |

So, counting each test in the configuration it needs: **97 of 98 pass, 1 was not run, 0 fail**. That figure combines separate runs on separate database states; the multi-academy and Google runs used the specs as they were before the last `dispatch-reports` edits (those two spec files were not touched in between).

## R3.6 The adult-profile privacy fix is intact

- `src/modules/players/application/service.ts` (the `ADULT_RECORD_PROTECTED` guard), `academy/domain/guardian-access.ts` and the dormant guardian-access code were **not touched**.
- `tests/legacy-adult-profile.test.ts` (5 tests) **passes on both engines** in the runs above; so does `guardian-access-domain` and the cross-academy, family-portal and dispatch authorization tests.
- No adult fixture was restored: the seed scripts are unchanged and create no adult; the one new fixture (Bluebird head-coach membership for the owner) is a second academy membership of an existing staff account, applied only to the disposable database and removed after the run.

## R3.7 Remaining failures and limitations

- The complete suite is **not one green command**: 91/3/4 as above. The three failures are configuration, not defects, and each passes in its configuration; but a CI job would need a second job (development server with the test adapter) and a fixture step for multi-academy, or those two specs need a decision (for example moving the test-adapter spec under a project that sets it up, and giving the multi-academy spec its own seed).
- **Specs that remain once-per-database:** `dispatch-reports` test 1 records a phone number and a consent, so a second run on the same database sees an extra message. Run it on a freshly seeded database (as `README`-style disposable instances already imply).
- **One test not run** (`auth-ui` 6-digit/reset flow, needs an e-mail provider stub).
- **Fixed delays that remain** (pre-existing, not introduced here): `waitForTimeout(500)` between settings tabs in `phase9-a11y`, the 60 s wait after a 429 in `phase9-family`, the 62 s wait in `multi-academy`'s sign-in helper. I did not add any.
- **Production-mode specifics of the test server:** plain `http` (cookies are `Secure`, which Chrome allows on loopback), no trusted proxy (one shared rate-limit bucket), no mail provider, no erasure ledger path. The real production environment does not exist yet (owner's statement, Round 2).
- Development-mode runs on this 8 GB machine remain slow and unstable; that is the reason the production build is the reference.
- All limitations of Rounds 1 and 2 stand. **This is not a statement of production readiness.**

## R3.8 Files changed in the project, and what was removed

| File | Change |
| --- | --- |
| `src/app/redesign.css` | `.set-counter` uses `var(--text-muted)`; new `.reference-view input.sr-only` rule |
| `src/modules/academy/ui/views/finance-view.tsx` | invoice select button: `aria-label` removed, name from content plus a visually hidden "select invoice N"; the player-name expression is computed once |
| `src/modules/reports/application/draft.ts` | evidence sorted by date, title, id |
| `src/modules/reports/domain/report-sheet.ts` | the sheet lists sessions in date order (stable), also for older stored drafts |
| `tests/monthly-report.test.ts` | new ordering test; `completedSession` accepts an optional date |
| `tests/e2e/monthly-report.spec.ts` | attendance assertions against the real elements; unique publish text; unused month from the server |
| `tests/e2e/redesign.spec.ts` | current composer steps; own report chosen; unique summary; wait for the notes tab; cached owner session |
| `tests/e2e/phase9-a11y.spec.ts` | stale duplicate test removed |
| `tests/e2e/phase9-family.spec.ts` | waits for "Sign in" to be enabled before typing |
| `tests/e2e/dispatch-reports.spec.ts` | rules restored and verified; waits on the save response; outbox read from the test's own start; unused month |
| `tests/e2e/batch-reports.spec.ts` | unused month from the server |
| `tests/e2e/coach-handover.spec.ts`, `payment-attempts.spec.ts`, `privacy.spec.ts` | cached role sessions instead of direct sign-in |
| `tests/e2e/support/months.ts` (new) | `unusedMonth(api)` |
| `ACCEPTANCE_HARDENING_REPORT.md` | this section |

**Removed after the work:** the disposable copy (`D:\Sportozen\_tmp-bm-e2e`), the PostgreSQL instance and its data folder, the PostgreSQL tool folder, the 3310/3311/3312 servers, the session cache in the temp folder. **Kept:** every `round3-*` log in the evidence folder. Nothing was committed.

## R3.9 Have the browser acceptance criteria been met?

**Partly, and I would not call the suite green.** Met: the five requested defects are fixed and verified (numbers above); the affected specs pass singly; the complete suite on a production build ends 91/3/4 and is reproducible; rate-limit and navigation failures are explained, and gone on the production build; the privacy fix is intact. **Not met:** a single unattended `playwright test` is not clean (3 failures need another configuration, 1 test was not run). **Decision needed from the owner:** how to run the two configuration-bound specs (a second server profile in CI, or give them their own setup), and whether to supply an e-mail provider stub for the one unrun test.

---

# Round 2: retiring the obsolete adult-player coverage, fixtures and one privacy defect

## R2.1 Staging and production

**Not applicable: environments not yet established, based on the owner's written confirmation** (no staging or production database has been
created or deployed for this project). This is the owner's statement; it was **not independently verified**. For what it is worth, nothing on this machine contradicts it:
none of ten database-related variable names is set, the project holds only `.env.example`, there is no `.pgpass`, no hosting or database
CLI, and `PRODUCTION_READINESS_REPORT.md` says nothing was deployed. The approved read-only query (section 6 of
`ADULT_PLAYER_DATA_INVESTIGATION.md`) was therefore not run anywhere remote. The only adult records ever found were 2 fictional seed fixtures
in the original project's development database. Nothing was modified in any database.

## R2.2 Files changed and why

| File | Change | Why |
| --- | --- | --- |
| `tests/adult-guardian-access.test.ts`, `tests/rc5-guardian-access-http.test.ts`, `tests/rc5-message-withholding.test.ts` | **deleted** | obsolete: see R2.3 |
| `tests/e2e/rc5-guardian-access.spec.ts` | **deleted** | browser spec of the adult's guardian-access screen |
| `tests/e2e/phase9-family.spec.ts` | adult player parts removed (one assertion, one screen test reduced to the second guardian); "Arjun Rao" added to the names a family must never see | the adult role no longer exists; the former adult is now an ordinary player other families must not see |
| `tests/e2e/phase9-a11y.spec.ts`, `tests/e2e/phase9-navigation.spec.ts` | one `ADULT_PLAYER` row removed from each table | the role fixture no longer exists |
| `tests/e2e/support/roles.ts` | `ADULT_PLAYER` account removed | no seeded adult login |
| `scripts/seed-operations.ts` | no adult user, no adult flag or own-account link, no "Adult self" guardian link | development seed must not create adults |
| `scripts/with-disposable-postgres.ts` | three suite entries removed; `legacy-adult-profile` added | PostgreSQL list |
| `playwright.isolated.config.ts`, `README.md` | retired spec and the adult account removed | consistency |
| `src/modules/players/application/service.ts` | refuse any save of a stored adult-controlled profile (`409 ADULT_RECORD_PROTECTED`) | R2.5 |
| `tests/legacy-adult-profile.test.ts` (new, 5 tests) | regression test for the transition | R2.5 |
| `tests/guardian-access-domain.test.ts` (new, 1 test) | the pure fail-closed rules test kept from the retired suite | the dormant code stays, so its pure rules stay pinned |

Unchanged on purpose: the dormant guardian-access implementation (`academy/application/access.ts`, `guardian-access.ts`, `domain/guardian-access.ts`
and the `ADULT_PLAYER` role, constraints and grant tables), `tests/rc5-guardian-access-view.test.ts` (pure screen rules), the unit-test fixtures in
`tests/helpers` that exercise the `ADULT_PLAYER` role (role behaviour tests), and the investigation evidence.

## R2.3 What was retired, why, and what covers the supported product

| Retired | What it tested | Why obsolete | Current coverage of the supported behaviour |
| --- | --- | --- | --- |
| `adult-guardian-access` (17 tests; 13 failed, 4 passed) | an adult player grants guardians sections of their record (AT-13 to AT-16), shared invoices and messages around adults | every test builds an adult; the app refuses to create one (`ADULT_PLAYERS_NOT_SUPPORTED`) | adult refusals: `invitations-http`, `player-age`, `operations`, `coach-assignment`; a **legacy** adult record stays hidden from ungranted guardians and from edits: new `legacy-adult-profile`; pure rules: new `guardian-access-domain`; a minor's guardians see every section: `family-portal-isolation`, `role-payload`, `data-access` |
| `rc5-guardian-access-http` (8) | the adult's screen contract over HTTP | same | screen rules: `rc5-guardian-access-view` (kept) |
| `rc5-message-withholding` (5) | messages withheld from guardians lacking MESSAGES (adult-controlled), plus consent-era wording | adults cannot exist; the consent gate was removed on 18 Nov | message delivery: `comms-dispatch`, `comms-providers`, `comms-phone`, `dispatch` (new delivery engine) |
| browser `rc5-guardian-access.spec.ts` | the adult's Access & preferences screen | no adult login | family isolation in the browser: `phase9-family` (guardians, second guardian, portal separation) |

**Coverage knowingly lost:** three of the four passing tests in `adult-guardian-access` exercised the dormant grant lifecycle (a baseline "minor sees all
sections", "a deactivated link closes the grant", "concurrent stale grant requests: one wins, one gets 409"). They needed an adult fixture the application can no longer
build through any route. The dormant grant code is therefore **no longer exercised end to end by any test**; only its pure rules and the legacy-record read protection are.

## R2.4 Seed and fixture verification

Fresh disposable database (embedded, throw-away folder), real scripts `migrate.ts`, `seed.ts` (which runs `seed-operations.ts`), then `seed.ts` again
(idempotent). Counts only (`acceptance-evidence\investigation\seed-verify-result.json`):

| Academies | Players | Profiles | Accounts | Guardian links | Adult-flag profiles | Own-account profiles | `ADULT_PLAYER` memberships | "Adult self" links | Grants |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 20 | 20 | 13 | 6 | **0** | **0** | **0** | **0** | 0 |

Roles seeded: owner 2, head coach 2, coach 2, nutrition 2, guardian 4. Browser fixtures: `ROLE_ACCOUNTS` has no adult; the browser run signed in as
every remaining role. Databases that were seeded before this change (the original project's development database) still hold the old fixture; they were not touched.

## R2.5 The adult-profile privacy finding

**Exact path (before the fix).** `savePlayer` (`players/application/service.ts`), for a stored profile with `adult: true` and a `selfUserId`: (1) the
form sends `adult:false, selfUserId:null` and `requireUnder18` accepts it; (2) the code stores `{...profile, adult:false, selfUserId:null}` whatever was stored; (3) because the stored flag was
true and the sent one false it calls `endGuardianAccess(..., "ENDED_ADULT_FLAG_CLEARED")`, which **revokes every grant the adult had made**. Result, as a single
silent edit: the record becomes a minor's, so **every linked guardian reads the whole record** (contact details, birth date, notes), and the adult's own account loses its link, so
**the adult is locked out of their own record**. Reproduced first: the new test failed on the unfixed code (the edit succeeded and an ungranted guardian then saw the record).

**Fix (no schema or model change).** Before anything is written, a save of a stored profile that the access layer already treats as adult-controlled
(`adultControlled`: flag not the boolean false, or an own-account link) is refused with `409 ADULT_RECORD_PROTECTED` and nothing is changed. The same fail-closed
definition the access layer uses for guardians is used, so a malformed profile with no flag is refused too. Ordinary players are unaffected. The other writers of
profiles were checked: age review keeps the flag; admissions creates new profiles with `adult:false`; privacy erasure blanks a record on purpose and is a separate owner-approved process.

**Proof (`tests/legacy-adult-profile.test.ts`, 5 tests, both engines):** the starting point (adult sees own record, ungranted guardian nothing, granted guardian only what was granted);
clearing the flag is refused for owner and administrator and leaves the stored profile byte for byte, the grant live (version 1), no access event written, and who-sees-what identical;
four other save variants and a coach are refused; a profile with no flag is refused; an ordinary minor can still be edited and an adult flag is still refused for them.

**Known limitation, not solved here:** a legacy adult can now not be edited, archived through the form or converted at all (the age review archives only players 18 or
older with a valid birth date). If a real database ever holds one, a deliberate owner-level "resolve legacy adult record" action would be needed (a domain decision, not built).

## R2.6 Verification and comparison with the previous baseline

Commands and results (logs in `acceptance-evidence\`):

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | clean (exit 0) |
| Lint | none exists: no `lint` script, no ESLint dependency or config. `npm run check:contrast` run instead | token pairs 28/28 pass; one literal text colour under 4.5:1: `.set-counter` (4.06:1, `redesign.css:4618`), **pre-existing**, also the axe finding below |
| Unit suite, embedded database, one file at a time | `NODE_OPTIONS=--max-old-space-size=3072 npx tsx --test --test-timeout=240000 tests/<file>.test.ts` (`run-full-suite-2.sh`; folder `full-suite-after-retirement`) | **101 files, 1,045 tests, 919 pass, 0 fail, 126 skipped**; plus `guardian-access-domain` (added after the loop started): 1 of 1. Total **1,046 / 920 / 0 / 126** |
| PostgreSQL 17 (disposable, local) | same command with `TEST_POSTGRES_ADMIN_URL` (`run-pg-suite-final*.sh`) | **70 files, 840 tests, 832 pass, 0 fail, 8 skipped** (7 Docker-runner tests need Docker; 1 database-outage test needs its own server, passed last round on unchanged worker code). One run was interrupted by a session end; the 11 files left were run separately and all 70 files are accounted for |
| Seed verification | see R2.4 | zero adult records |
| Migration and transaction guards | `migrations` (89 on PostgreSQL), `migrations-0013` to `0019`, `rc2-static-gates` (AT-17), `authority-equivalence`, `role-payload`, `auth-endpoint-surface`: inside the runs above | all pass on both engines (no migration or schema file was changed) |
| Authorization and privacy | `legacy-adult-profile`, `dispatch-authorization`, `cross-academy`, `dual-academy-idor`, `family-portal-isolation`, `rc5-staff-portal-http`, `invitations-http`, `consent`, `privacy`, `access-audit`: inside the runs above | all pass on both engines |

**Baseline comparison (previous round: embedded 1,070 / 918 pass / 26 fail / 126 skipped; PostgreSQL 71 files, 863 / 829 / 26 / 8).**
Embedded: 1,070 − 30 retired (17 + 8 + 5, of which 26 failed and 4 passed) + 6 new = **1,046; pass 918 − 4 + 6 = 920; fail 26 − 26 = 0; skipped 126 unchanged**.
PostgreSQL: three files retired (−30 tests), two added and one extra worker test (+7) → 840; failures 26 → 0. **Newly introduced unit or PostgreSQL failures: none. Pre-existing failures: the 26 were removed by retirement, not hidden; skips are unchanged and listed above.**

### Browser suite (Playwright, disposable copy with its own database, development server)

> **Corrected in Round 3 (R3.2):** the `redesign` rows below were misdiagnosed (the `.reference-view` selector is fine; the real causes were a stale composer step, a genuine Settings sideways-scroll defect, a non-repeatable fixed text and two races), and the `monthly-report` "may once have matched a page number" guess was wrong (both assertions simply described wording the screen and PDF never used). The sign-in 429 and navigation rows were the slow development server and specs signing in directly. Read R3.2 and R3.4 instead of this table.

Command: `playwright test -c playwright.isolated.config.ts` with `testMatch` widened to every spec in the disposable copy (`browser-full-run.log`). One change in the
copy only: `phase9-a11y.spec.ts` declares the same test title twice (the second a stale pre-redesign copy), which makes Playwright refuse to load the file; the stale duplicate was dropped in the **copy**, the
project file is unchanged and **needs a decision**. Result: **98 tests: 73 passed, 13 failed, 12 skipped (1.1 h)**. There was **no earlier complete browser run to compare with**; my own specs (`batch-reports`, `dispatch-reports`) and `phase9-family`
(adult parts removed) passed in it. Every failure was then examined and re-run on its own on a fresh instance:

| Failure | Cause and evidence | Class |
| --- | --- | --- |
| `monthly-report` "Coach: numbered workflow…" (133) | expects the sheet to read "2 of 3 sessions · 67%"; the screen shows "2 / 3 … 67% attendance" (sheet markup not changed in this round); fails on a fresh instance too | **stale spec (pre-existing)** |
| `monthly-report` "Approval and publication…" (242) | expects the string "2 / 3" in the PDF text; the PDF shows "Sessions attended 2 of 3". It may once have matched a page number ("2 / 3"); not verifiable without a baseline | **stale or coincidental assertion (pre-existing)** |
| `redesign` ×2 | wait for `.reference-view`, a class now rendered only by Communications, Finance and Settings, not by the modules the spec opens | **stale spec (pre-existing)** |
| `phase9-a11y` "Owner: every module" and "Settings tabs" | axe: colour contrast on `.set-counter` (the same element `check:contrast` flags). A re-run also found `label-content-name-mismatch` on the invoice select buttons of `/fees` (appears once invoices exist) | **pre-existing accessibility defects** (need a design decision) |
| `phase9-a11y.spec.ts` as a file | duplicate test title, above | **pre-existing defect** |
| `phase9-family` "A message written by a guardian persists…" | after sign-out the test types into the sign-in page before it is ready (snapshot: empty e-mail field, "Enter your email address", no request sent); **passes when the test waits for the page to settle** (experiment on the copy) | **test timing race** (not app logic) |
| `coach-handover`, `payment-attempts`, `privacy`, `phase9-auth` "Wrong password…" and "Account security", `phase9-responsive` 375px | sign-in 429 / "Too many requests" in the long run, or a 10-minute timeout; **each passes when run alone** | **environment: sign-in rate limit and a slow development server** |
| `phase9-navigation` (ADMIN, and in later runs OWNER, HEAD_COACH, COACH, sidebar, account menu) | a click does not navigate within 30 s, or the sign-in request takes over 60 s; **the failing step differs on every run**, FINANCE and NUTRITION pass | **environment: on-demand compilation on an 8 GB machine** |
| `invitations` (1 failed, 3 "did not run") and `multi-academy` (3 of 4 failed) | skipped in the long run for want of `E2E_SEED_PASSWORD` (a variable this runner did not set); with it set they progress (the invitation is created and opened) then time out on a page transition ("Create an account", landing on `/`) | **not verified in a browser: environment.** The same flows are covered at HTTP level by `invitations-http` (26, both engines) incl. accept with phone and WhatsApp opt-in |
| 12 skipped | Google not configured (3), mail provider not configured (1), `E2E_SEED_PASSWORD` not set (8), as above | their own preconditions |

**Browser verdict:** no failure is attributable to this round's changes by the evidence above, but the suite is **not green**, and a run on a production build, or on a
machine with more memory, is needed before it can be called verified. The invitation and multi-academy specs, and the progress section on the family report (verified in the previous round on a
quieter run), were not re-verified by a clean browser run this time.

## R2.7 Remaining limitations and production-readiness gaps

- No production or staging environment exists (owner's statement); nothing here has run against real infrastructure, a real provider, or a real PostgreSQL service; the PostgreSQL used was a local native server.
- Browser suite not green and not reproducible on this machine (R2.6); the stale specs, the `.set-counter` and `/fees` accessibility defects and the duplicate-title file need owner decisions or a small separate task.
- A legacy adult record, if one ever exists, is protected from silent change but cannot be edited or resolved (R2.5); the dormant grant code has no end-to-end test now (R2.3).
- All limitations from round 1 stand: no real e-mail or WhatsApp provider, no unsubscribe link, real `SIGTERM` handling not exercised on Linux, no load test at 500+ recipients, PDF checked by text positions only.
- Open decisions: email provider and sender domain; WhatsApp business account and templates; PostgreSQL and worker hosting; legal advice on messaging minors' families.

## R2.8 Explicit recommendation

**Accept round 2** (retirement, seed and fixture cleanup, privacy fix with its regression test) on the unit and PostgreSQL evidence. **Do not accept the browser suite as verified** and **do not describe the application as production-ready.**
Before any production use: run the browser suite on a production build or a larger machine, decide on the stale specs and accessibility defects, and take the round 1 decisions above.

---

# Round 1 (previous report; still valid where not superseded above)

## Task 1: the 27 failures, one by one

Baseline run: 1,054 tests, 910 pass, 27 fail, 117 skipped (log `full-suite-2026-11-21.log`). Final run on the finished code:
**1,070 tests, 918 pass, 26 fail, 126 skipped** (103 files, `acceptance-evidence\full-suite\`).

| # | Test (file) | Reason it failed | Class | Evidence |
| --- | --- | --- | --- | --- |
| 1 | AT-17 transactions allow-list (`rc2-static-gates`) | the new worker (2 transactions) and webhook event handler (1) are unguarded-by-design transactions that were not in the reviewed allow-list | **New regression from this milestone: FIXED** (entries added with reasons) | 4/4 pass now |
| 2–14 | `adult-guardian-access` (13): AT-13 recording adulthood; AT-13 no-grant routes; only the adult can grant; AT-15 seven scopes; AT-15 scope-gated writes; AT-15 matrix; AT-15 guardians separately; AT-16 consent; AT-14 shared invoice; MESSAGES; fail closed; clearing the adult flag; adult with no account (PD-2) | every one builds its fixture by saving a player as an adult (`adult: true, selfUserId`). Since 18 November `requireUnder18` refuses that with `422 ADULT_PLAYERS_NOT_SUPPORTED` and `savePlayer` stores `adult:false, selfUserId:null` whatever is sent, so the player stays a minor and the guardian legitimately sees everything the test expects hidden | **Intentional product restriction** (owner decision 18 Nov: players are under 18) | below |
| 15–22 | `rc5-guardian-access-http` (8): the screen's read by role; seven sections; all/subset/no-op/revoke; consent never a section; stale version; only the adult can grant; inactive link; adulthood cleared | same: setup returns `422 ADULT_PLAYERS_NOT_SUPPORTED` | **Intentional product restriction** | below |
| 23–27 | `rc5-message-withholding` (5): processOutbox withdrawn grant; never held MESSAGES; bootstrapFamily withheld delivery; unrelated recipients; alternate paths | same setup `422`; a second layer (consent removal, 18 Nov 23:29) changes some expected wording and rows | **Intentional product restrictions** (two of them) | below |

**Were they pre-existing?** Yes. (a) Your 18 November memory note already records exactly these three suites, 13 + 8 + 5, as failing by
design. (b) The code that causes them was last changed on 18 November, before this milestone: `players/application/age-rules.ts`
(17:15), `players/application/service.ts` (17:18), `admissions` (17:18), `settings` (19:23), `communications/application/service.ts`
(23:29), `bootstrap-family.ts` (19 Nov 00:14). The guardian-access code they exercise (`academy/application/access.ts`,
`guardian-access.ts`, `domain/guardian-access.ts`) last changed 12–13 November. The milestone touched none of these.

**Did I just wave them through? No: I tested the intended behaviour.** In a throw-away copy I lifted the restriction at its four points
(`requireUnder18`, the admissions and invitation refusals, the `adult:false` forcing in `savePlayer`) and re-ran the three suites with
the milestone's code:

| Suite | Result with the restriction lifted | What the remainder is |
| --- | --- | --- |
| `adult-guardian-access` | **16 of 17 pass** | the 17th (PD-2) fails only on its last line, "a minor cannot be given an own account", which is the very rule I lifted |
| `rc5-guardian-access-http` | **8 of 8 pass** | nothing |
| `rc5-message-withholding` | 1 of 5 pass; in the other 4 the withholding itself works (the withheld guardian's delivery is `SKIPPED` on every channel) | expectations from before the consent decision: the reason text `Consent or access was revoked.` is now `No longer a linked parent.`; "consented to PORTAL only" now also gets an e-mail row; a different "nobody can receive" sentence |

So the adult-protection code underneath is intact and not regressed by this milestone; the suites fail because the product no longer
lets an adult exist. **Decision for you (not taken):** (A) retire the three suites, the two adult e2e specs and the dormant adult
guardian-access code together once you confirm no real database holds an adult profile; or (B) keep the code and rewrite the suites to
plant adult rows directly in the database, with the consent-era wording updated. I did not delete or edit them.

**Environment-dependent (found while doing Task 2, not among the 27):** `calendar-series` "DEC-2" failed on PostgreSQL only. Cause: the
test's helper starts a refusing request, then awaits a snapshot, so a fast server rejects before `assert.rejects` attaches a handler
(unhandled rejection). Pre-existing (file unchanged since 9 Nov; it passed in Docker on 17 Nov on slower timing). Fixed in the test with
one line; 22/22 on both engines.

## Task 2: PostgreSQL (disposable local PostgreSQL 17.11 on 127.0.0.1, random password, throw-away data folder)

Docker Desktop was not running and the machine has ~8 GB, so I ran a native PostgreSQL 17 from the free `embedded-postgres` package
in a scratch folder; the tests use the same `TEST_POSTGRES_ADMIN_URL` mechanism as `npm run test:pg` (each test gets its own new
database). Results, latest run of each file: **71 files, 863 tests, 829 pass, 26 fail, 8 skipped.** The 26 are the same three adult
suites (identical to PGlite). The 8 skips are the Docker-runner tests (7, need Docker) and the outage test on the shared server (it
passes on its own server, see Task 3).

| Required check | Result |
| --- | --- |
| Full migration chain incl. 0019 | `migrations` 89/89 (was 46 on PGlite), `migrations-0019` 13/13 (7 PGlite + 6 PostgreSQL + pin), 0013–0018 files all pass |
| Migration rollback | 0019 rollback rehearsal and guard (refuses unless applied once with the reviewed hash, latest, schema intact, history confirmed) pass on PostgreSQL; earlier rollbacks 0004–0018 in `migrations` pass |
| Advisory-lock draft creation; concurrent report generation | `report-engine`: three simultaneous creators for one player and period → exactly one draft, two "exists"; also on PostgreSQL |
| Dispatch claiming with SKIP LOCKED | new: ten simultaneous passes with separate connections over 300 items → each item claimed once (`attempts = 1`), 300 sends, no key twice, more than one pass did real work |
| Multiple workers | see Task 3 (two real processes) |
| Lease recovery | new: an expired lease is reclaimed by exactly one of two simultaneous passes; an unexpired one is left alone |
| Retry and failure handling; duplicate prevention | `dispatch` 13/13 on PostgreSQL; real-process retry exhaustion and bounce in Task 3 |

## Task 3: the worker as a separate operating-system process (`tests/dispatch-worker-process.test.ts`, 9/9 on PostgreSQL)

Real `scripts/dispatch-worker.ts` processes, the test adapter (nothing leaves the machine), logs asserted to carry counts only.

| Scenario | Result |
| --- | --- |
| Start and graceful shutdown | logs `started` (e-mail TEST, WhatsApp NONE), asked to stop → finishes, logs `stopping`/`stopped`, **exit 0** |
| Queue persistence | 12 messages wait while no worker runs, nothing moves or is lost; a worker started later sends each once |
| Two workers at once | 150 items: claimed exactly once between them, both took part, 150 messages, no key twice |
| Crash recovery | worker `SIGKILL`ed mid-send: all items stay leased and unsent-looking, an unexpired lease is respected, after the lease a new worker recovers all; the messages already handed to the provider when it died were sent twice (4 of 6 in the recorded run, each with the same idempotency key) |
| Slow but live worker | send outlives its lease: second worker takes over, the late result cannot overwrite it; message sent twice |
| Database interruption | server stopped mid-send: the same worker stays up, logs `pass.failed` (code only, no query), recovers by itself on restart, nothing lost, in-flight messages sent again, later work sent once |
| Retry exhaustion | an always-failing address: 6 attempts, retries waited after each of the first five, then `FAILED`, never claimed again; a bounce fails at once and nothing is sent for either |

**Worker changes made for this (small):** the worker now survives a database outage instead of crashing (a worker that never completed a
pass still exits 1), wakes immediately on a stop request, releases its IPC channel so it can exit, and prints a reason code rather than a
database message (those can quote a query and its parameters). Test adapter gained two test-only rules: `always-retry` addresses and
`DISPATCH_TEST_SEND_DELAY_MS`.

**Delivery guarantee, stated plainly: AT-LEAST-ONCE, never exactly-once.** A message can reach the provider twice if a worker dies, the
database is lost, or a worker is slower than its lease between the provider accepting it and the worker recording that. Every such
repeat carries the same idempotency key (the item id); nothing is sent more than twice in any tested case. Keep the lease far above the
provider timeout (Meta adapter 15 s, lease 120 s). Documented in `DISPATCH_OPERATIONS.md`.

**Not exercised:** real `SIGTERM` under a Linux service manager. Windows cannot deliver it to a child; the same stop function is
reached by `SIGINT/SIGTERM/SIGHUP/SIGBREAK` handlers and by the IPC message that was tested.

## Task 4: parent-facing report and PDF

One model (`reports/domain/report-sheet.ts`) now feeds the screen, the plain-text lines and the PDF, so they cannot disagree. New section
**Progress compared with the period before**: attendance "n of N sessions (x%)" for both periods and the difference in percentage points;
practice minutes by area for both periods with a total; reviewed-observation counts per category and each reviewed observation with its
category; a **"Not recorded in this period"** list; and the existing coach summary, strengths, areas to improve, development priorities and
closing note. Wording is numbers only. The approved report's analysis is a snapshot inside the versioned report, so a revision keeps it.

- Not exposed: working notes, the session recap, unreviewed observations (tests plant "PRIVATE NOTE" text and search the family's data and the PDF), the coach-only `facts` drafting aid (now also removed from the family's data), anyone else's report (another parent is refused the PDF).
- Consistency fix: the analysis percentage now uses recorded sessions only, like the report headline, so the two numbers can never differ.
- Tests: `report-sheet` (8), `report-progress` (3: publish → family payload → PDF text, equal on both; privacy; revision keeps the snapshot), `report-engine` updated for the single rule, browser test below. A sample PDF is in the evidence folder; I printed every text position of the new section and checked there is no overlap or page-break problem.
- Not verified: a visual render of the PDF (no PDF viewer here; the check was by text positions and text content); older reports made before the analysis existed show no progress section by design.

## Task 5: security regression

| Area | Verified by | Result |
| --- | --- | --- |
| Parent-child report access | `dispatch` link test; `report-progress` (other parent refused); browser: wrong parent and staff refused | pass |
| Shared contact handling | `contacts` (4 combinations, nobody merged), `invitations-http` shared phone | pass |
| Cross-academy isolation | `cross-academy`, `dual-academy-idor`, `dispatch-authorization` (404 for other academy on every operation), `family-portal-isolation`, `role-payload` | pass (both engines) |
| Invitation expiry and revocation | `invitations-http` (26) | pass (both engines) |
| WhatsApp opt-in and STOP | `contacts`, `dispatch` events, `dispatch-webhook` | pass |
| Report-link expiry and revocation | `dispatch` link test (expired, revoked, forged, withdrawn) | pass |
| Webhook signature and replay | `dispatch-webhook` | pass |
| Batch authorization; retry and cancel | **new** `dispatch-authorization` role-by-operation matrix | pass |

**A real finding, fixed:** `dispatchBatchStatus` and `listDispatchBatches` were open to anyone allowed to prepare messages, which
includes a coach. A coach could therefore read every batch the academy sent, with parents' names and masked addresses for other coaches'
players. Both now need the right to approve sending (owner, administrator, head coach); a coach still previews their own players, sees no
history, and the panel says why. Pinned by the new test.

## Task 6: final regression (exact commands and results, reported separately)

| Run | Command | Result |
| --- | --- | --- |
| Embedded database (PGlite), all files, one at a time | `NODE_OPTIONS=--max-old-space-size=3072 npx tsx --test --test-timeout=240000 tests/<file>.test.ts` for each of 103 files (`run-full-suite.sh`) | **1,070 tests: 918 pass, 26 fail, 126 skipped.** The 26: `adult-guardian-access` 13, `rc5-guardian-access-http` 8, `rc5-message-withholding` 5. The skips are PostgreSQL variants and the PostgreSQL-only process tests |
| PostgreSQL 17, all PostgreSQL-capable files | same command with `TEST_POSTGRES_ADMIN_URL` set to the disposable server (`run-pg-suite*.sh`), plus a final pass of all 27 affected or new files on the finished code | **71 files: 863 tests, 829 pass, 26 fail (same three suites), 8 skipped** |
| Worker as real processes | `TEST_POSTGRES_ADMIN_URL=… TEST_POSTGRES_STOP_CMD=… TEST_POSTGRES_START_CMD=… npx tsx --test tests/dispatch-worker-process.test.ts` | **9 of 9** |
| Browser (Playwright, disposable copy, own database, test adapters) | `playwright test -c playwright.isolated.config.ts tests/e2e/batch-reports.spec.ts tests/e2e/dispatch-reports.spec.ts` | **4 of 4** (incl. the parent's portal showing the progress section) |
| Types | `npm run typecheck` | clean |
| Guard files after the last change | `rc2-static-gates`, `authority-equivalence`, `role-payload`, `auth-endpoint-surface`, `rc5-staff-portal-http`, `family-portal-isolation` | all pass |

Not run: the older e2e specs outside this milestone, and the two adult e2e specs (they test the removed feature).

## Files changed in this phase

Source: `scripts/dispatch-worker.ts`; `src/modules/dispatch/application/service.ts`; `src/modules/dispatch/providers/test-adapter.ts`;
`src/modules/reports/domain/report-sheet.ts`; `src/modules/reports/domain/report-analysis.ts`;
`src/modules/reports/application/report-pdf-layout.ts`; `src/modules/academy/ui/report-sheet-view.tsx`;
`src/modules/academy/ui/views/dispatch-panel.tsx`; `src/modules/academy/application/bootstrap-family.ts`; `src/app/redesign.css`.
Tests: new `report-progress`, `dispatch-authorization`, `dispatch-worker-process`; changed `report-engine`, `calendar-series`
(one line, see above), `tests/e2e/dispatch-reports.spec.ts`. Docs: `DISPATCH_OPERATIONS.md`, `REPORT_AUTOMATION.md`, this file.
**No migration was added or changed.** Migration 0019 was applied to the disposable PostgreSQL databases only.

## Remaining limitations

- No real provider has been contacted: the official WhatsApp adapter matches Meta's documented shapes only; no e-mail adapter; no unsubscribe link yet (needed before live e-mail).
- Real `SIGTERM` handling on Linux not exercised; throughput beyond 300 items in one process and 150 across two workers not measured; no load test at 500+ recipients.
- PostgreSQL ran natively on Windows 11, not in the Docker image `npm run test:pg` uses; a run in the Docker image before production is sensible.
- The PDF layout was checked by text positions, not rendered visually.
- Open decisions (yours): retire or rewrite the three adult suites; email provider and sender domain; WhatsApp business account and templates; PostgreSQL and worker hosting; legal advice on messaging minors' families; whether to show the progress analysis to **players' own** messages (they have no login, unchanged).
