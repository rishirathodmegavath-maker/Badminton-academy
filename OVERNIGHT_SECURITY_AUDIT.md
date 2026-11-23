# Overnight security audit (2026-11-13)

Scope: the implementation as it stands on branch `security-privacy-phase2` (uncommitted working tree, Phases 1–3 included).
Method: the code was read and probed directly; earlier audit documents were not relied on. Where a claim says **verified**, the
evidence is a test, a negative control or a live request against a disposable server, named next to it. Nothing was run against
the development or any production database.

**Result: no CRITICAL and no HIGH finding.** Four defects were fixed and proved (S-1, S-2, S-12, S-13), one hardening was added (S-4),
and one MEDIUM design weakness (S-3, the squatted address and the invitation link) is investigated with a recommendation that needs
your approval. Everything not fixed is listed with its reason.

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-1 | LOW | Stock `POST /api/auth/verify-password` is a password-guessing oracle for any session holder | **Fixed, verified** |
| S-2 | MEDIUM | `pg` Pool had no `error` listener: a database restart could crash the server | **Fixed, verified (unit level)** |
| S-3 | MEDIUM | In the no-mail launch configuration the invitation link is the only real secret (unverified, squattable addresses) | Investigated; mitigation **needs approval** |
| S-4 | LOW | `X-Powered-By` exposed; no `Permissions-Policy`, no COOP | **Fixed, verified** (test + `curl -I` on the rebuilt production server) |
| S-5 | MEDIUM | No CSP, no HSTS (application level), no readiness endpoint | Not fixed (deployment decisions) |
| S-6 | LOW | Sign-up answers `EMAIL_IN_USE` (account enumeration) | By design, rate limited; accepted |
| S-7 | LOW | Training API checks body size after buffering the body | Not fixed (authenticated only); proxy limit advised |
| S-8 | LOW | A pending invitation token is kept in `sessionStorage` across the sign-in redirect | Not fixed; mitigated |
| S-9 | LOW | Without `TRUSTED_PROXIES` all clients share one rate-limit bucket per endpoint | Documented existing trade-off |
| S-10 | LOW (privacy) | An invitee's email stays in `academy_invitation` forever (immutable by design); account erasure is not built | Decision needed |
| S-11 | LOW | A per-account lockout lets anyone pause one account's sign-in for 15 minutes | Documented existing trade-off |
| S-12 | MEDIUM (availability) | An unsafe production configuration printed "will not start" but the process **stayed alive and not listening** | **Fixed, verified** (exit code 1 after 3 s on the real build) |
| S-13 | LOW | `PRIVATE_MEDIA_PATH` and `ERASURE_LEDGER_PATH` are required in production but neither validated at start-up nor listed in `.env.example` (uploads answered 503 on first use) | **Fixed (warnings + documentation), verified by test** |
| S-14 | INFO | Stock `two-factor/send-otp` and `verify-otp` exist but are inert (no OTP sender configured) | Verified live; pinned by the endpoint-surface test |

---

## Fixed findings

### S-1 — `verify-password` oracle (LOW) — fixed and verified
* **Where:** Better Auth's stock endpoint `/verify-password`, reachable because `BLOCKED` in
  `src/modules/identity/account-security.ts` (the set of stock routes the application disables) did not list it.
* **Reproduction:** sign in, then `POST /api/auth/verify-password {"password": "<guess>"}`. A wrong guess answers
  `400 INVALID_PASSWORD`, the right one `200`. Observed live on a disposable server.
* **Impact:** anyone holding a session cookie (stolen or on an unattended screen) could test password guesses at the general rate
  limit (60/min per address, one shared bucket without `TRUSTED_PROXIES`), outside the per-account sign-in throttle, the owner
  re-authentication counter and the authenticator lockout, and with no security event. The password alone does not sign in an
  account that has an authenticator, so the practical impact is limited, but the oracle has no purpose: the application never calls it.
* **Fix:** `"/verify-password"` added to `BLOCKED`; added to the "stock password and account routes are not reachable" test
  (`tests/account-password.test.ts`).
* **Verified:** the test passes with the fix and **fails without it** (negative control run: the entry was removed, the test
  failed on `verify-password`, and the file was restored).

### S-2 — Unhandled pool errors (MEDIUM, availability) — fixed and verified at unit level
* **Where:** `src/infrastructure/database/client.ts`, the `pg` `Pool` created from `DATABASE_URL`.
* **Reproduction:** `new Pool(...).emit('error', new Error('idle client lost'))` throws, because an `EventEmitter` with no `error`
  listener turns the event into an uncaught exception. node-postgres emits it when an idle connection fails (database restart,
  failover, network reset, idle reaper).
* **Impact:** one PostgreSQL restart or failover would terminate the Node process instead of reconnecting on the next query.
* **Fix:** `src/infrastructure/database/pool-guard.ts` attaches a listener that logs only the error name and code (a message can
  carry a connection string) and lets the pool discard the dead connection.
* **Verified:** `tests/database-pool-guard.test.ts` (real `pg` `Pool` class): without the guard the emit throws; with it nothing
  throws and a message containing a connection string is not logged. **Not verified:** a real database restart under load.
  A rehearsal (restart the disposable container while a request loop runs) is listed in `PRODUCTION_READINESS_REPORT.md`.

### S-4 — Response headers (LOW) — fixed and verified
* **Observed:** `X-Powered-By: Next.js` on every response; no `Permissions-Policy`; no `Cross-Origin-Opener-Policy`
  (`curl -I` on the production-mode server).
* **Fix (`next.config.ts`):** `poweredByHeader: false`; `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`
  (checked first: the UI uses none of these APIs, only the clipboard, which is not restricted); `Cross-Origin-Opener-Policy: same-origin`.
* **Verified:** `tests/security-headers.test.ts`, and `curl -I` on the rebuilt production server shows the three headers and no `X-Powered-By`.

### S-12 — A refused production start left a zombie process (MEDIUM, availability) — fixed and verified
* **Where:** `src/instrumentation.ts` called `assertSecurityConfig()`, which throws on an unsafe production configuration.
* **Reproduction:** `NODE_ENV=production`, `TRUSTED_PROXIES=0.0.0.0/0`, no `DATABASE_URL`, `next start`. Next printed "Failed to prepare
  server ... The application will not start." and then **kept running without listening**: still alive after 25 s (`timeout` had to kill it), port refused connections.
* **Impact:** a supervisor (systemd, Docker, Kubernetes, a process manager) sees a running process, never restarts it and never alerts; a
  misconfiguration looks like a hang. The mistake is found by an outage, not by a failed deployment.
* **Fix:** `startup-guard.ts` ends the process with exit code 1 after printing the same value-free findings. `tests/startup-guard.test.ts`;
  `tests/security-config.test.ts` (the hook test now asserts the exit). **Verified on the rebuilt production server: exit code 1 after 3 s.**

### S-13 — Required production storage paths were not validated (LOW) — fixed
* `src/infrastructure/storage/private-files.ts` answers 503 "Private storage is not configured." when `PRIVATE_MEDIA_PATH` is unset in production; the
  privacy ledger needs `ERASURE_LEDGER_PATH`. The README required both, but `.env.example` did not list them and the start-up review never mentioned them,
  so the first sign was a failed upload. Found because the `redesign` browser spec failed on a disposable server started without it.
* **Fix:** the start-up review warns by name (not an error, so a deployment that never stores media still starts); `.env.example` documents both.
  `tests/security-config.test.ts`.

---

## S-3 — Squatted addresses and the invitation link (MEDIUM) — investigated, mitigation needs your approval

**What is actually true in the current code** (`onboarding.ts` signup, `invitations/application/service.ts`):

1. With no mail provider (the launch configuration) public signup creates an **unverified** account for any address, immediately
   usable (`email_verification_required = false`). Anyone can therefore register someone else's address first.
2. An invitation is accepted by the signed-in account **whose email equals the invited address**, and only with the secret token.
   Because address ownership is unproven (point 1), the address match is **not** a proof of anything; the token is the only real
   secret. A leaked link (a forwarded message, a WhatsApp group, a screenshot) can be accepted by anyone who registers the invited
   address, including an invitation for the OWNER role (the inviting owner's password and authenticator were checked when the invitation
   was made, not at acceptance).
3. The reverse also hurts: if an attacker pre-registers the address, the real person cannot register it (`EMAIL_IN_USE`), cannot
   sign in to the squatter's account, and so cannot use the link that was handed to them. The owner sees nothing wrong.
4. Mailbox-based recovery and Google linking already require a **verified** address, so they are not affected.

**Options considered (none needs a paid service):**

| Option | Closes | Cost / risk |
|---|---|---|
| A. A second secret in a different channel: an 8-character passcode shown to the owner next to the link, stored only as a keyed hash, required at acceptance, five wrong attempts lock that invitation | Leaked or forwarded link (point 2), including for OWNER invitations | New column(s) and a migration (0019), UI change in the panel and the `/invite` page; owner must pass two things to the person (link and passcode) by two routes |
| B. Let the holder of a valid link take over an unverified, membership-less, session-less squatter account (set a password for it) | Point 3 | Strengthens attack 2 (anyone with a leaked link could seize the account); only acceptable together with A |
| C. When a mail provider is configured, require `email_verified` to accept | Points 2 and 3 completely, automatically, for deployments that have mail | Needs a provider; does nothing for the launch configuration |
| D. Operational: hand the link over in person or by direct message only, 1–3 day expiry, withdraw unused links, require MFA enrolment of owners (`MFA_ENFORCEMENT=enforce` for OWNER) | Reduces exposure | No code; depends on discipline |

**Recommendation:** ship **A** (with **C** as the automatic upgrade when a provider exists) and apply **D** now. A without B is safe;
B must never ship alone. A is a Phase 3 follow-up, not part of Phase 4. **Nothing was changed tonight** because A changes the schema and
the owner workflow you approved in Phase 3. Until it ships, `RELEASE_PREREQUISITES.md` and `AUTH_ONBOARDING.md` already state the
weakness.

---

## Not fixed

* **S-5 — CSP, HSTS, readiness endpoint (MEDIUM, defence in depth).** HSTS belongs at the TLS-terminating proxy (a wrong value cannot be
  undone from the server). A Content-Security-Policy needs a nonce strategy for Next's inline bootstrap scripts and is a project of
  its own; without it a script-injection bug would be able to read `sessionStorage` (see S-8). `/api/auth/ok` is a liveness answer only
  (it does not touch the database); there is no readiness endpoint. See `PRODUCTION_READINESS_REPORT.md`.
* **S-6 — sign-up enumeration.** `POST /onboarding/signup` answers `409 EMAIL_IN_USE` (documented: there is no mailbox proof to
  hide behind). Sign-in answers wrong password and unknown account identically (`tests/http-auth.test.ts`). Bounded by 5/min per
  address and a per-email limiter.
* **S-7 — body size on the training route.** `src/app/api/training/[[...path]]/route.ts` trusts `Content-Length` and then
  `request.text()` before checking `raw.length`; a chunked body without a length is fully buffered first. Authenticated
  (member) requests only; the academy route streams with a hard cap. Fix is small but changes a hot path and cannot be shown
  by a behavioural test, so it is left; set `client_max_body_size` (or equivalent) at the proxy.
* **S-8 — token in `sessionStorage`.** `src/modules/invitations/ui/pending-invite.ts` keeps the token (not the address) for the sign-in
  detour and clears it on use, refusal or a terminal answer. Script injection is the only way to read it; the fragment itself
  is removed from the address bar on arrival, the `Referrer-Policy` is `same-origin`, and the token is used only in POST bodies.
* **S-9, S-11** are existing, documented trade-offs (`client-ip.ts`, `sign-in-throttle.ts`).
* **S-10 — invitee email retention.** `academy_invitation.invitee_email` is immutable and rows are never deleted (a trigger enforces
  this so a used token cannot return). Erasure today covers one player, not accounts (`PRIVACY_LIFECYCLE.md`), so this is consistent
  with the rest of the system, but when account erasure is designed it needs a controlled redaction path (for example a
  privileged `SECURITY DEFINER` function that blanks the address and nothing else).

---

## Verified controls (what was checked and how)

| Area | Result | Evidence |
|---|---|---|
| Tenant scoping of queries | Of every `from/update/delete/join` on a table that has `academy_id`, only 5 lack an academy filter; all 5 are keyed by user or session by design (`active-academy.ts` ×3, `google.ts` `isProvisioned`, `security-events.ts` `soleAcademy`) | static scan over `src/**/*.ts` against the real schema |
| Authorization at every write entry | All 51 actions in the academy route begin with `requireCapability`, `unit()` (which re-locks the actor) or a documented in-function family/owner check; `players/consent` delegates to the consent module after `family()` | static scan + reading `saveConsent` |
| Academy context | The academy is resolved on the server from live memberships and the session's stored choice; no client academy id is read (`access.ts`, `active-academy.ts`) | `tests/multi-academy-selection.test.ts`, new `tests/dual-academy-idor.test.ts` |
| Cross-academy IDOR by a person who owns **both** academies | Refused for reads and writes while working in the other academy; controls pass in the owning academy | new `tests/dual-academy-idor.test.ts`; **mutation check**: removing the academy filter from `revokeInvitation` makes it fail (`invitations/revoke across academies -> 200`) |
| CSRF | Every non-GET on the academy and training APIs requires `Origin` equal to the application origin; Better Auth enforces it on its own routes | live: no `Origin` → 403 `MISSING_OR_NULL_ORIGIN`; foreign origin → 403 `INVALID_ORIGIN`; academy API without origin → 403 |
| Cookies | `__Secure-` prefix, `HttpOnly`, `Secure`, `SameSite` in production; `SameSite=Lax`, 12 h, host-only in development | live `Set-Cookie`; `tests/cookies-production.test.ts`, `tests/http-auth.test.ts` |
| Stock auth routes | `update-user` of identity fields → 403 (managed by the owner); `change-email` → `CHANGE_EMAIL_DISABLED`; `delete-user` → 404; stock `sign-up/email` → `EMAIL_PASSWORD_SIGN_UP_DISABLED` and **no row created**; `list-sessions` returns no tokens | live probes, `tests/account-password.test.ts` |
| Sessions | Revoked on password change, admin reset, password reset, sign-out; an expired row is rejected; deactivation applies to a signed-in session at once | `tests/account-password.test.ts`, `account-reset.test.ts`, `http-auth.test.ts` |
| Password reset | Tokens single-use, expiring, every session ended, no session issued; owner reset refuses OWNER targets and (since Phase 2) people who also belong to another academy | `tests/account-reset.test.ts`, `multi-academy-side-effects.test.ts` |
| Brute force | Per-address limits on every sensitive route, per-account claim-first throttle (10 / 15 min), owner re-auth counter (5), authenticator lockout (10 → 15 min) | `sign-in-throttle.ts`, `tests/rate-limit-*.test.ts`, `owner-concurrency.test.ts` |
| Open redirects | None: every redirect target in the UI is a fixed path or the server-built Google URL | grep of `src/app` |
| OAuth | State and PKCE; implicit linking disabled; sign-up only from the sign-up screen with terms and a verified Google email; Google refused for accounts with an authenticator | `tests/google-signin.test.ts`, `auth-google-initiation.spec.ts` (3/3 on the fake-credential profile) |
| Invitation tokens | 256 random bits; stored only as HMAC-SHA256 under a key derived from `BETTER_AUTH_SECRET`; in the URL fragment, removed from the address bar, used only in POST bodies; never in the log, list, audit or database in clear | `tests/invitations-http.test.ts` (21 tests, "TOKEN HYGIENE", "AUDIT") |
| Invitation lifecycle | pending → accepted / revoked / expired are final (database trigger); replay idempotent for the same person and refused for others; concurrent acceptance creates one membership; inviter re-validated at acceptance; guardian links start with no consent; an Owner invitation needs the step-up when made | `tests/invitations-http.test.ts`, `tests/migrations-0018.test.ts` |
| SQL injection | All access is through Drizzle's parameterised builders; the few `sql` fragments interpolate column references and bound values only (`sign-in-throttle.ts` uses explicit UTC text parameters) | reading every `sql\`` site |
| Logging | Only four `console` sites in `src`: request failure (error name only), audit failure, start-up proxy warning, security-config findings (names, never values) | grep |
| Dependencies | `npm audit` (production and dev): 0 vulnerabilities | run 2026-11-13 |
| Migration safety | 0018 is additive; guarded rollback refuses unless 0018 is the latest and intact and refuses while invitations exist unless confirmed | `tests/migrations-0018.test.ts` on PG17/18; rehearsal on a copy of the development database (see `MIGRATION_0018_EXECUTION_RUNBOOK.md`) |

## What this audit did not cover
* A penetration test with an external tool, a fuzzer or a load test.
* The real Google round trip (needs real credentials and a real account; rotate the client secret that appeared in the transcript).
* Real mail delivery (Resend/ZeptoMail) — nothing was sent.
* TLS, reverse proxy, firewall and host configuration (none exists in the repository).
* ESLint: the project has no ESLint configuration or dependency, so no lint run exists to report.
