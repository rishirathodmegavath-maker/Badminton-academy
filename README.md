# Sportozen Badminton Academy

A badminton academy workspace for planning training, managing players and admissions, reviewing development reports, and coordinating family communication. Built with Next.js, React, TypeScript and PostgreSQL.

The application includes a responsive Overview dashboard with academy-scoped records and branch filtering. Local development uses explicitly seeded fictional academies; production deployment is not included.

## Modules

| Module | Current functionality |
| --- | --- |
| Overview | Local-time greeting and date, branch filtering, active-player and session counts, outstanding fees, review queues and linked actions |
| Admissions | Enquiries, follow-ups, trials, attendance, feedback and conversion to enrolled players |
| Players | Profiles, guardian relationships, enrolment history, attendance and development links |
| Calendar | Week and month views, coach/batch/branch filters, events, closures and conflict validation |
| Training Studio | Drill library, custom drills, session builder, save/publish, live timer, attendance, private observations, completion and duplication |
| Reports | Reviewed evidence, report lifecycle, approval, publication and private PDF export |
| Nutrition | Structured guidance, professional review, questions and explicit family sharing |
| Fees | Plans, invoices, submitted payment references, verification, receipts, refunds and lesson credits |
| Communications | Drafts, recipient previews, approval, scheduled outbox, private conversations and actual delivery status |
| Video & AI Analysis | Private image/video playback and timestamped coaching notes; AI Analysis is Coming Soon |
| Settings | Academy preferences, branches, batches, roles, invitations, two-factor policy, audit records and integration status |
| Privacy and consent | Versioned consent, sensitive-data access history, retention rules, two-person erasure with legal holds ([CONSENT.md](CONSENT.md), [ACCESS_AUDIT.md](ACCESS_AUDIT.md), [PRIVACY_LIFECYCLE.md](PRIVACY_LIFECYCLE.md)) |
| Family portal | Guardians and adult players see only their linked records and what was explicitly shared ([GUARDIAN_ACCESS.md](GUARDIAN_ACCESS.md)) |

## Local setup

Requires Node.js 24 (tested with 24.18.0), npm, and Google Chrome for browser tests.

```powershell
npm ci
Copy-Item .env.example .env.local
```

Configure `.env.local`:

```dotenv
BETTER_AUTH_SECRET=<a random secret of at least 32 characters>
BETTER_AUTH_URL=http://127.0.0.1:3100
LOCAL_DATABASE_PATH=./.data/development
ALLOW_DEV_SEED=true
DEV_SEED_PASSWORD=<choose a local-only password of at least 12 characters>
```

Leave `DATABASE_URL` empty for the local embedded PostgreSQL database (PGlite). To use an external PostgreSQL server, configure `DATABASE_URL` instead. Only one process may access a PGlite directory at a time: stop the development server before migrating or seeding it.

```powershell
npm run db:migrate
npm run db:seed
npm run dev
```

Open [Sportozen](http://127.0.0.1:3100/) and sign in. Keep the development server running while using the app. The development command uses Webpack and binds to the local machine on port 3100.

### Database migrations

`npm run db:migrate` applies `migrations/` to whichever database the environment names: `DATABASE_URL` (PostgreSQL) if set, otherwise the embedded database at `LOCAL_DATABASE_PATH`. It does not need the `BETTER_AUTH_*` settings. `npm run db:migrate:plan` lists what would run and changes nothing (it never creates or touches an embedded data directory). The operator scripts (`db:migrate`, `db:migrate:plan`, `db:seed`, `auth:check-config`, `auth:recover`, `privacy:*`) read `.env.local` when it exists and otherwise use the process environment, so on a production host that has no `.env.local` supply the variables in the environment (values already in the environment win over the file).

Safeguards, all enforced by `src/infrastructure/database/migrations.ts`:

- **All-or-nothing.** Pending migrations run in one transaction; a failure leaves the database exactly as it was.
- **One migrator at a time.** A PostgreSQL advisory lock refuses a second concurrent run ("already running"); re-run after the first finishes.
- **History must be consistent.** Every recorded migration must exist, once, with unchanged content; a migration that was never applied but is older than one that was (for example merged from another branch) is refused, because drizzle would otherwise skip it silently. Line endings are ignored when comparing content, so Windows (CRLF) and Linux (LF) checkouts agree; `.gitattributes` keeps `migrations/*.sql` LF.
- **Remote targets need confirmation.** The runner resolves the host the PostgreSQL driver will really connect to (including `?host=`, `?port=`, `PGHOST`). Anything that is not loopback is refused unless `MIGRATION_CONFIRM_TARGET` equals the printed `host:port/database`, for example `MIGRATION_CONFIRM_TARGET=db.example.com:5432/sportozen npm run db:migrate`. Unix-socket hosts need the same confirmation; `hostaddr` is rejected. Credentials are never printed.
- `MIGRATION_STATEMENT_TIMEOUT_MS` (default 300000) caps any single statement.

Production uses `DATABASE_URL` only; the embedded database is refused when `NODE_ENV=production`.

### Client addresses and sign-in rate limiting

Sign-in is limited to 5 attempts per minute per client address. A browser can send any `X-Forwarded-For` value, and Next.js only fills that header from the socket when the client did not send one, so the header is **ignored unless you declare your proxy chain**:

- `TRUSTED_PROXIES` (comma-separated IPs/CIDRs) declares that all traffic arrives through those proxies, that they append the connecting client's address to the header, and that the application port is reachable only through them (bind it to the proxy network or firewall it). The client is the right-most address that is not a trusted proxy; forged values to its left are ignored. List only infrastructure addresses, never a network that end users can connect from: a connection from a listed address is believed when it forwards (pinned by a characterisation test). `TRUSTED_CLIENT_IP_HEADER` (default `x-forwarded-for`) names the header. In production, invalid entries and ranges that match every address (`0.0.0.0/0`, `::/0`) stop the server at start-up (development prints a warning).
- **Unset (the default), every client shares one limit per endpoint.** Guessing stays limited whatever headers are sent, but one attacker can also lock everyone out of sign-in. Production logs a warning in this mode.

Remaining limitations: address limits alone cannot stop many real addresses guessing at one account, so sign-in also has a per-account throttle (10 consecutive failures pause that account for 15 minutes, see [ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md)); IPv6 clients are grouped by /64. Without `TRUSTED_PROXIES` the address-based limits (including the two-factor endpoints, 10/min) are shared by every client.

### Account security

Password change, owner-authorised password reset, 72-hour temporary passwords with forced rotation, TOTP two-factor authentication with recovery codes, a staged MFA rollout policy (`MFA_ENFORCEMENT`, off by default) and operator recovery (`npm run auth:recover`) are described, with the full threat model, recovery matrix and deployment requirements, in [ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md). People manage their own password, authenticator and devices at `/account`. There is no email-based self-service reset because no email provider has been selected.

**`BETTER_AUTH_SECRET` also encrypts authenticator secrets and recovery codes: do not change it after people have enrolled without planning an authenticator reset.**

Owners and admins can review account-security events (password changes and resets, lockouts, two-factor changes, member deactivation) in Settings -> *Security events*. `npm run auth:check-config -- --production` reviews the security-related environment settings without printing any value; the same review runs when the server starts and, in production, stops it on an invalid or unsafe setting. Details, the safe MFA rollout order and trusted-proxy requirements are in [ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md).

Two-factor authentication is **optional until an owner raises the policy**: Settings -> *Two-factor policy* (owners change it, admins view it) takes each role through *warning* and then *required*, with a readiness report, a mandatory warning stage and a security-log entry for every change. The approved defaults require it of the six staff roles and leave guardians and adult players optional; nothing is switched on by deploying. See "Phase 4" in [ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md).

Consent for communications is recorded as an append-only, versioned history (who, when, how, on which document); the current flags that gate messaging are derived from it. Owners and admins publish consent documents in Settings -> *Consent documents*; families give and withdraw consent in their portal. Architecture, authority rules, API, migration and the open legal questions are in [CONSENT.md](CONSENT.md).

### Fictional development accounts

All seeded accounts use the `DEV_SEED_PASSWORD` you configure. No password is stored in this README.

| Account | Role |
| --- | --- |
| `admin@greenfield.example` | Academy owner |
| `headcoach@greenfield.example` | Head coach |
| `aman@greenfield.example` | Assigned coach |
| `nutrition@greenfield.example` | Nutrition professional |
| `priya@greenfield.example` | Guardian |
| `maya@bluebird.example` | Coach at a separate fictional academy |

Seeding is explicit, rerunnable, and refused in production. Rerunning the seed does not reset existing account passwords. `unassigned@example.test` is a test account without academy membership and is denied academy access.

## Verification

```powershell
npm run typecheck
npm test
# Requires the seeded local server to be running and Chrome installed:
npm run test:e2e
# Focused overview checks and responsive screenshots:
node scripts/redesign/overview-check.mjs
# Production compilation:
npm run build
```

The original 25 service/domain tests cover academy isolation, assigned-coach restrictions, session transitions and concurrency, attendance, admissions, calendar conflicts/DST, fees, report/nutrition approval, communication consent and private media.

Browser tests exercise the actual local APIs and create labelled fictional QA records. `npm test` uses separate databases under ignored `.data/`; the integration suites remove what they create, while the original service tests leave their `ops-*`/`test-*` directories there (safe to delete). Do not run browser tests against production. Login rate limiting remains enabled.

#### Integration test infrastructure

- `tests/helpers/harness.ts` starts the real route handlers behind a real HTTP server with a disposable migrated database, real Better Auth sign-in and cookie sessions, and the fictional fixtures in `tests/helpers/fixtures.ts` (all eight roles, a second tenant with its own owner, coach and guardian, and an empty tenant). Every record type carries unique `CANARY-…` values so a substring search of any response proves or disproves a disclosure.
- `tests/role-payload.test.ts` holds the exact canary-visibility matrix per role, a coverage guard that fails if any collection has no fixture data, and value-free key-path snapshots (`UPDATE_SNAPSHOTS=1` records a reviewed change). Finance and Nutrition Pro are held to a frozen superset of what they receive today; the tests marked `todo` describe proposed (not approved) policy and are reported as TODO, never as passing.
- `tests/cross-academy.test.ts` checks every ID-addressed endpoint in both directions across tenants, each with a same-shape positive control.
- `npm test` runs three files at a time (`--test-concurrency=3`): each loads an embedded WebAssembly database and a higher fan-out exhausts memory on small machines. Each test has a 4-minute ceiling.
- `npm run test:pg` runs the PostgreSQL-dependent suites (migrations, production-mode cookies, and the HTTP suites on a real server) against a throw-away container; Docker is required. The container binds to 127.0.0.1 with a random password and is removed on success, failure, timeout, Ctrl+C and SIGTERM; orphans from a hard kill are swept at the next start. `TEST_POSTGRES_IMAGE` selects the image (default `postgres:17-alpine`). Without Docker those tests are reported as SKIPPED.
- `tests/account-*.test.ts`, `tests/mfa*.test.ts` and `tests/recovery-cli.test.ts` cover Phase 2.2 over the same HTTP harness: all eight roles, password change, owner reset authorization (including cross-academy and peer/self/multi-academy denials), temporary-password expiry and forced rotation on every route, session revocation, TOTP enrolment/challenge/replay/brute force, recovery codes, MFA rollout modes, the sign-in throttle and the operator command. Authenticator codes come from an independent RFC 6238 implementation (`tests/helpers/totp.ts`).
- `npm run typecheck` is non-incremental so a stale `tsconfig.tsbuildinfo` can never hide an error.

## Architecture

- **Frontend:** Next.js App Router, React, TypeScript, semantic CSS, locally bundled fonts and Lucide icons.
- **Identity:** Better Auth email/password login with database-backed sessions, rate limiting, optional TOTP two-factor authentication and an `account-security` plugin (password change, owner reset, forced rotation, audit trail). Anyone can create an account (email and password, or Google when configured), but a new account has **no academy access**: joining an academy is by an owner's invitation only (Settings > Invitations), never by signup or an email match. One login may belong to several academies; the active academy is part of the session and is switched at `/academies`. See [ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md), [AUTH_ONBOARDING.md](AUTH_ONBOARDING.md), [GOOGLE_SIGN_IN.md](GOOGLE_SIGN_IN.md) and [MULTI_ACADEMY_IDENTITY_DESIGN.md](MULTI_ACADEMY_IDENTITY_DESIGN.md).
- **Authorization:** eight stored roles (OWNER, ADMIN, HEAD_COACH, COACH, FINANCE, NUTRITION_PRO, GUARDIAN, ADULT_PLAYER), all decisions through `src/modules/identity/authority.ts`; a database CHECK refuses any other role. Every write re-validates the actor inside its transaction, an academy always keeps an active owner (application check plus deferred database triggers), and granting or removing OWNER needs a password and authenticator step-up. See [GUARDIAN_ACCESS.md](GUARDIAN_ACCESS.md).
- **Data:** Drizzle ORM with PostgreSQL migrations. Local PGlite and external `pg` adapters share the schema.
- **Services:** Server-side validation, academy and role checks, transactions, optimistic version checks and audit records. Client-provided academy IDs do not determine access.
- **Training:** Published rosters and drill snapshots preserve historical evidence. Timers do not infer attendance or performance. Schedule instants use UTC with academy-local date/time and IANA timezone validation.
- **Privacy:** Coach views are scoped to assigned records. Family views expose authorised linked-player records and explicitly shared content. Financial information and nutrition review actions require appropriate roles. Media storage stays private.

```text
src/app/                         Pages, API routes and shared styling
src/modules/                     Domain rules, application services and UI by module
src/infrastructure/database/     PostgreSQL schema and database adapters
src/infrastructure/storage/      Private-file storage
migrations/                      Versioned SQL migrations and schema metadata
scripts/                         Database setup and local verification scripts
tests/                           Service tests, browser flows and QA fixture
artifacts/                       Fictional-data screenshots and visual comparisons
sportozen-codex-pack/             Original implementation brief and references
```

## Screenshots and implementation notes

- [Overview desktop screenshot](artifacts/overview/overview-1672.png)
- [Overview mobile screenshot](artifacts/overview/overview-375.png)
- [Overview comparison viewer](artifacts/overview/index.html) — open locally to compare with the supplied reference.
- [Overview verification notes](artifacts/overview/README.md)
- [Application redesign status](REDESIGN_STATUS.md)
- [Module audit](MODULE_AUDIT.md)
- [Original Training implementation notes](IMPLEMENTATION_STATUS.md) — historical scope and validation.

Dashboard totals come from authorised records. Outstanding fees include overdue balances once. Submitted payment references remain unverified until a permitted user verifies them. Goal review dates are not recorded, so the Overview shows active goals. Notifications are omitted because no notification service is implemented.

## Integration and production requirements

AI analysis is Coming Soon. Email (Resend or ZeptoMail), WhatsApp and Google sign-in adapters exist and stay unavailable until configured; they are tested against stubbed provider endpoints, and **no live provider round trip has been made**. Payment references are manually submitted and verified; no payment gateway charges are simulated. Communication screens retain recorded approval, scheduling and delivery states without claiming unsupported delivery.

Production requires external PostgreSQL, a migrated schema (`0000` to `0018`), an HTTPS `BETTER_AUTH_URL` (one exact origin), a unique strong auth secret, `DATABASE_URL`, and a persistent private storage location configured with `PRIVATE_MEDIA_PATH`; `TRUSTED_PROXIES` and `ERASURE_LEDGER_PATH` are strongly recommended. Embedded PGlite is rejected in production. The migration chain and the PostgreSQL-dependent suites are tested on PostgreSQL 17 and 18 (disposable containers); a hosted PostgreSQL service and a production deployment have **not** been verified. There is currently no supported way to create the first academy and owner outside the development seed (operator provisioning is not built). See [RELEASE_PREREQUISITES.md](RELEASE_PREREQUISITES.md) for migration order, rollback and environment details.

Further work includes production account provisioning/recovery, backup and restore verification, monitoring, larger-dataset pagination, and staff/security/accessibility review. Reusable versioned training templates, detailed goal editing/history and published-session correction workflows remain incomplete.

`.env.local`, local databases/uploads, build output, browser traces, dependencies and generated export ZIPs are excluded from Git. Configure secrets separately in each environment.
