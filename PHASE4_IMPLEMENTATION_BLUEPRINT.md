# Phase 4 implementation blueprint — academy lifecycle, platform administration, first-academy bootstrap

**Status: PLANNING ONLY. Nothing in this document is implemented and Phase 4 is not approved.** It is based on the code as it is
today (read on 2026-11-13), not on earlier design notes. Section 6 lists the decisions I need from you; Section 7 gives the order
I would build it in.

## 0. Starting point (what exists, verified in the code)

| Fact | Where | Consequence for Phase 4 |
|---|---|---|
| The `academy` table has only `id` (text), `name`, `timezone`. No status, no creation time, no creator. | `schema.ts` `academies` | Lifecycle needs new columns (migration 0019). |
| The only way to create an academy today is the **fictional dev seed** (`scripts/seed.ts`, refuses production). Production has no way to create the first academy or Owner. | `scripts/seed.ts` | This is the production blocker Phase 4C removes. |
| Authority is entirely per academy: `authority.ts` derives everything from a stored membership role; `resolveActor` refuses anyone without an active membership. There is **no platform-level actor**, no `platform_operator` table, no flag on `app_user`. | `authority.ts`, `access.ts` | Platform administration needs its own model; it must not be an academy role. |
| "Operator" authority today = **access to the server and its database credentials**, exercised through scripts that print the target and need `--yes` (and `MIGRATION_CONFIRM_TARGET` for a remote database). The OS account is the operator identity; owner restoration needs **two different operator accounts** and a one-time approval code. | `scripts/recover-account.ts`, `operator-recovery.ts`, `owner-recovery.ts`, `migrations.ts` (`assertSafeTarget`) | The bootstrap and lifecycle commands should follow the same pattern. |
| A tamper-evident, hash-chained operator log already exists, keyed per academy, stored in `security_event` (`seq`, `prev`, `hash`), with `verifyRecoveryChain`. Rows with a null `academy_id` chain under the key `""`. | `owner-recovery.ts` | Reuse the chain mechanism for platform events instead of inventing another. |
| The database refuses to leave an academy without an **active OWNER**, but only when a **membership** is changed or deleted (deferred constraint trigger). It does **not** stop an academy from being created with no membership at all. | `0013_role_validation_owner_presence.sql` | Creating an academy and its first Owner must be one transaction, and Phase 4 should add the missing creation-time guarantee. |
| An Owner can invite others (`invitations`, 0018), but an invitation needs an inviter who is already a member (composite foreign key). It cannot create the first Owner. | `academy_invitation` | The first Owner is created by the operator CLI, not by an invitation. |
| Credentials for a person created by someone else: `installTemporaryCredential` (72-hour, single-use temporary password, forced change, all sessions ended) and the MFA enrolment gate. | `credentials.ts`, `account-gate.ts` | Reuse for the first Owner; never print a permanent password. |
| Background workers act per academy: the outbox (`processOutbox`, `auth-email-worker`) and the privacy worker (`systemUnit(academyId)`). | `communications`, `privacy/process.ts` | Suspension must define what workers do (Section A). |
| `feature_entitlement` (per academy) already exists. | `schema.ts` | Candidate home for per-academy feature flags set by the platform. |

---

## A. Academy lifecycle

### A.1 Current limitations
No status, no created-at/by, no suspension, no archival, no way to stop an academy (a non-paying or abusive one, or a compromised one)
without editing the database by hand; no way to create one in production; deleting an academy is not defined (and must not be done by
`DELETE`, which would cascade through legal-retention data: invoices, consent, audit).

### A.2 Required changes
**States:** `ACTIVE` → `SUSPENDED` ⇄ `ACTIVE`; `ACTIVE`/`SUSPENDED` → `ARCHIVED` (terminal for the application; reversible only by an operator).

| State | Members can sign in | Reads | Writes | Outbound messages | Invitations (create/accept) | Erasure worker |
|---|---|---|---|---|---|---|
| ACTIVE | yes | yes | yes | yes | yes | yes |
| SUSPENDED | yes, but the academy answers `ACADEMY_SUSPENDED` (a person in several academies can still use the others) | **no** (decision D3 below: owners may be allowed a read-only export) | no | **stopped** (outbox skips) | refused | **continues** (a legal duty; decision D4) |
| ARCHIVED | same as suspended | no | no | stopped | refused | continues until its retention plan completes |

* **Enforcement point.** `resolveMembership` (`active-academy.ts`) already joins `academy`; it must treat a membership in a
  non-ACTIVE academy as "not usable" with a new stable code. The check must **also** be made inside `unit()` after the academy
  row lock is taken (the lock is already there), so a suspension and an in-flight request are ordered by the database, not by timing:
  a request either finished before the suspension committed or is refused.
* **Chooser and shell.** `/academies` lists a suspended academy as unavailable with its reason code, never with internal notes.
* **Invitations.** `createInvitation` and `acceptInvitation` refuse for a non-ACTIVE academy (the lock is already taken).
* **Owner lifecycle.** An academy always has at least one active Owner (database guarantee, plus a new creation-time check, below).
  Transfer of ownership = invite a second Owner (existing step-up), then demote or deactivate the first (existing last-owner guard).
  Operator restoration of a lost Owner stays as is (`auth:recover --restore-owner`, two operators).
* **Configuration.** Name, timezone and settings stay Owner-editable; the status, the creation record and entitlements are **platform-only**.
* **Deletion.** No hard delete in this phase. "Delete" = ARCHIVE + the existing retention/erasure lifecycle (`PRIVACY_LIFECYCLE.md`).
  A later, separately approved procedure may purge an archived academy after its retention periods, as a scripted, two-operator, backed-up operation.

### A.3 Database implications (migration 0019, additive)
```sql
ALTER TABLE academy
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN status_reason text,                 -- short, owner-visible code or sentence, never internal notes
  ADD COLUMN status_changed_at timestamp,
  ADD COLUMN created_at timestamp NOT NULL DEFAULT now(),
  ADD COLUMN created_by text;                    -- operator identity string (OS account), not a user id
ALTER TABLE academy ADD CONSTRAINT academy_status_valid CHECK (status IN ('ACTIVE','SUSPENDED','ARCHIVED'));
-- Existing academies stay ACTIVE (the default). Creation-time owner guarantee:
CREATE CONSTRAINT TRIGGER academy_has_owner AFTER INSERT ON academy DEFERRABLE INITIALLY DEFERRED ...
  -- at COMMIT the new academy must have an active OWNER membership, so no transaction can leave an ownerless academy.
```
A guarded rollback in the repository's convention (hash-pinned, refuses unless 0019 is the latest) accompanies it, as for 0012–0018.

### A.4 API design
CLI first (Section C); no web endpoint changes the lifecycle in this phase. The application only **reads** the status
(`resolveMembership`, `unit()`, chooser).

### A.5 Permission requirements
Status changes: operator only (CLI). Owners can see their academy's status (read-only) and nothing else about it.

### A.6 Security implications
Suspension is an availability control, not a confidentiality one: data stays in place. A mistaken suspension must be reversible at once
(`activate`). The status check sits in the one place every request already passes (`resolveActor` → `resolveMembership`, and `unit()`),
so no route can forget it. Workers are the places that can forget; each gets a test.

### A.7 Test strategy
* Unit: transition table (allowed/forbidden transitions, idempotent repeats).
* HTTP (real server, PGlite and PostgreSQL 17/18): a suspended academy refuses every route with `ACADEMY_SUSPENDED` for every role
  including Owner; the same person's other academy keeps working; reactivation restores access without a new sign-in; a suspension
  committed while requests are in flight orders cleanly (concurrency test in the style of `owner-concurrency.test.ts`).
* Workers: outbox sends nothing for a suspended academy; the erasure worker still runs.
* Migration test in the folderBefore/folderThrough style, rollback test, guarded-rollback refusal tests.
* Ratchets: AT-17 transaction allow-list entries for any new transaction.

### A.8 Acceptance criteria
1. No application route, worker or CLI path can read or write an academy's data while it is SUSPENDED/ARCHIVED, except the documented ones.
2. An academy cannot exist without an active Owner, including through a failed or partial bootstrap.
3. Every transition is recorded in the platform log (B.4) with operator, reason and before/after.
4. 0019 applies and rolls back on PGlite and PostgreSQL 17/18; the whole `tests/migrations.test.ts` passes.

---

## B. Platform administration

### B.1 Current limitations
There is no platform authority at all. "Operator" is a person with a shell and the database credentials; every operation is a script.
That is a sound, small attack surface for a handful of operations, but it gives no list of academies, no oversight, and no web access
for an operator who should not hold database credentials.

### B.2 Required changes — recommended in two steps
**Step 1 (this phase): CLI-only operator console** — `npm run platform:*` scripts using the existing operator model (OS account identity,
target-database guard, `--yes`, two-operator approval for the dangerous ones). No new web surface, no new kind of login.

| Command | Effect | Confirmation |
|---|---|---|
| `platform:academies` (list) | id, name, status, created, active-owner count, member counts, last activity | read-only |
| `platform:academy-show <id>` | the same plus entitlements and the last platform events | read-only |
| `platform:academy-suspend <id> --reason` / `-activate` | status change (A) | `--yes` |
| `platform:academy-archive <id> --reason` | status ARCHIVED | `--yes` **and** a second operator's approval code (as owner restoration) |
| `platform:entitlement <id> <feature> on\|off` | `feature_entitlement` | `--yes` |
| `platform:verify-log` | verifies the platform hash chain | read-only |
| `academy:bootstrap` | Section C | `--yes` |

**Step 2 (later, separate approval): a web platform console** at a separate path with its own login, only if you need operators
without database credentials. Design constraints if it is built:
* Separate model, never an academy role: table `platform_operator(user_id PK, status, created_by, created_at)`; a separate module
  `platform-authority.ts` with its own `platformCan()`; **never** reuse `can()` or add a role to `STORED_ROLES`.
* A platform operator is **not** a member of any academy and sees **no private data** (no players, reports, finance lines,
  messages, media). Metadata only (the table above). Looking into an academy is a *break-glass* action: a reason, a second operator's
  approval, a time limit (for example 60 minutes), a read-only view, and a prominent entry in the academy's own security log.
* Authentication: password **and** a mandatory authenticator, no Google, short sessions (30 minutes idle), re-authentication for
  every state change, optional source-address allow-list, rate limits as for owner re-authentication (5 failures).
* A platform operator account must not be usable as an academy login and vice versa (separate cookie name or an `aud` claim).

### B.3 Database implications
Step 1: only 0019 (Section A) plus the platform log (B.4). Step 2 adds `platform_operator`.

### B.4 Audit trail
A **platform event log** with a global hash chain (`seq`, `prev`, `hash`), append-only enforced by a trigger in the style of
`academy_invitation_guard` (no UPDATE, no DELETE, no TRUNCATE). Events: `ACADEMY_CREATED`, `ACADEMY_SUSPENDED`, `ACADEMY_ACTIVATED`,
`ACADEMY_ARCHIVED`, `ENTITLEMENT_CHANGED`, `BOOTSTRAP_FAILED`, `BREAK_GLASS_OPENED/CLOSED` (step 2). Fields: operator identity,
academy id, reason, before/after status, no secrets. Each state change that affects an academy **also** writes an academy-scoped
`security_event` (so the Owner sees "your academy was suspended by the platform", with the reason code), using the existing chain.
`platform:verify-log` and the existing `--verify-recovery-log` run together in the release checklist.

### B.5 Permission requirements
Step 1: OS-level access to the server and database credentials (as today). Step 2: `platform_operator` + authenticator + per-action
re-authentication + second approver for archive, break-glass and operator management.

### B.6 Security implications
A platform console concentrates power across **all** tenants, so it is the highest-value target in the system; that is why step 1 adds
no web surface and why step 2, if built, is data-blind by default. Operator mistakes are bounded by the confirmation rules, the
reversible states and the append-only log. Suspending the academy an operator is investigating must not delete evidence: states never
delete rows.

### B.7 Recovery procedures (documented and rehearsed before release)
1. *Wrong academy suspended:* `platform:academy-activate`; verify with a member's session; the log shows both events.
2. *Only Owner locked out:* existing `auth:recover` (temporary password) or `--restore-owner` (two operators).
3. *Operator log damaged or suspected tampered:* `platform:verify-log` identifies the first bad event; restore the database from the
   last verified backup; replay nothing automatically.
4. *Lost operator access (step 2):* another operator, or the CLI with database credentials, deactivates and recreates the account.

### B.8 Test strategy
Authorization matrix for every command (no `--yes`, wrong target database, remote database without `MIGRATION_CONFIRM_TARGET`, same operator
as approver); log chain tests (tamper detection, gap detection, concurrent writers); no command prints a secret; every command is
idempotent (repeat = no change, no duplicate event). Step 2 adds: no route returns academy private data (a canary test in the style of
`cross-academy.test.ts`), break-glass expiry, separate-cookie isolation.

### B.9 Acceptance criteria
Every platform action is attributable, logged in a verifiable chain, reversible or explicitly two-person, and exposes no private academy
data; an operator can list and suspend any academy; nothing in the web application gains a platform capability in step 1.

---

## C. First-academy bootstrap CLI

### C.1 Current limitation
No production path to a first academy and Owner. Seeds are fictional-only; an Owner can only be created by an existing Owner.

### C.2 Command
```
npm run academy:bootstrap -- --name "Acme Badminton Academy" --timezone Asia/Kolkata \
    --owner-email owner@example.com --owner-name "A. Owner" [--request-id <uuid>] [--yes]
```
* Default (no `--yes`): **dry run**. Prints the target database (`describeTarget`), the academy that would be created, whether the owner
  address already has an account (and in which academies), and what credential would be issued. Changes nothing.
* A remote database additionally needs `MIGRATION_CONFIRM_TARGET=host:port/database` (as for migrations and recovery).
* The operator identity is the OS account (as in `recover-account.ts`).

### C.3 Behaviour (one transaction, then output)
1. Validate inputs (name 2–120 chars, IANA timezone, email shape, name length); refuse placeholder-looking names and the `example` domains
   unless `--allow-test-data`.
2. `BEGIN`; take an advisory lock on the request id; check the idempotency record (C.5).
3. Insert `academy` (UUID id, `status ACTIVE`, `created_by` = operator), its default `academy_settings` (the existing `defaultSettings`), and any
   baseline rows the application needs for an empty academy (to be confirmed by a test that opens every screen on a new academy).
4. Owner account: **new** address → create `app_user` (unverified, `email_verification_required = false`, terms not yet accepted) and a
   credential row with a one-time temporary password through `installTemporaryCredential` (`source: OPERATOR_BOOTSTRAP`);
   **existing** account → no credential change and no session revocation (it may belong to other academies); only the membership is added.
5. Insert the OWNER membership; record `ACADEMY_CREATED` in the platform log and an academy-scoped `OWNER_GRANTED` (`method: "bootstrap"`)
   in the academy's chain. `COMMIT` (the deferred owner-presence trigger runs here).
6. **After** commit, print once: academy id, owner address, and — for a new account — the temporary password and its expiry. It is not stored in readable form.

### C.4 Credential handling
Never accept a password on the command line (it would sit in shell history and process lists). The temporary password is generated,
shown once, expires in 72 hours, forces a change at first sign-in, and the Owner is gated into authenticator enrolment (set
`MFA_ENFORCEMENT` to include OWNER before launch). It is handed over through a channel other than the one that carried the address.

### C.5 Idempotency and partial failure
* **Idempotency key:** `--request-id` (generated and printed if absent) is stored in the `ACADEMY_CREATED` platform event with a hash of the
  inputs. Re-running with the same id and the same inputs answers "already done" and shows the academy id **without** reprinting any secret;
  the same id with different inputs is refused.
* **Atomicity:** academy, settings, account, credential, membership and log entry are one transaction. A crash before `COMMIT` leaves
  nothing; a crash after `COMMIT` but before the output was seen leaves a complete academy whose only missing piece is the operator's
  copy of the temporary password, which is reissued with the existing `auth:recover --email <owner>` (a sole-academy account, so the normal path).
* **Duplicates:** an academy with the same normalised name is refused unless `--allow-duplicate-name`; the same owner address never
  creates a second account.
* **A failed attempt is itself logged** (`BOOTSTRAP_FAILED`, reason code, no secrets) in a separate transaction.

### C.6 Security implications
Highest-impact CLI in the system (it mints an Owner). Controls: dry run by default, target guard, OS-account identity recorded,
no secret in arguments or logs, one-time temporary credential, authenticator gate, chain-logged, refuses production-looking test data,
and **cannot** be reached from the web application (a static test asserts no route imports it). An existing-account Owner needs the
operator to have confirmed the person out of band, because the address is unverified (see S-3 in `OVERNIGHT_SECURITY_AUDIT.md`).

### C.7 Test strategy
PGlite and PostgreSQL 17/18: new owner; existing single-academy account; existing multi-academy account (credentials untouched);
dry run changes nothing; remote-target refusal; repeat with the same request id (no second academy, no reprinted secret); same id with
different inputs; kill the process between statements (transaction wrapper fault injection) and prove all-or-nothing; owner-presence trigger
fires if a bug omits the membership; output contains the password exactly once and the log never contains it; first sign-in forces the
change and the authenticator gate; a brand-new academy opens every screen with no data (browser spec) and can create its first batch, player,
invitation.

### C.8 Acceptance criteria
From an empty production database plus this command, a person can sign in, replace the temporary password, enrol an authenticator, and
use an empty academy end to end; repeating the command never duplicates anything and never reveals a secret twice.

---

## 6. Decisions needed from you
| # | Decision | My recommendation |
|---|---|---|
| D1 | CLI-only platform operations in this phase (step 1), web console later? | Yes. |
| D2 | Archive needs a second operator? | Yes (same as owner restoration). |
| D3 | May an Owner of a **suspended** academy read or export their data? | Read-only export for 30 days after suspension, never writes. Needs your policy. |
| D4 | Do erasure and retention workers keep running for a suspended/archived academy? | Yes (legal obligations). |
| D5 | Should outbound messages queued before suspension be dropped or held until reactivation? | Hold; send nothing. |
| D6 | New Owner for an **existing** account allowed without mailbox proof? | Yes, but only through the CLI and with the operator's out-of-band check recorded (`--verified-by "<how>"`, stored). |
| D7 | Real academy-name uniqueness rule? | Case-insensitive unique among non-archived academies, override flag for the operator. |
| D8 | Where do operators run the CLI (which host, which credentials)? | A single documented bastion; credentials never on laptops. |
| D9 | Authenticator mandatory for OWNER at launch (`MFA_ENFORCEMENT=enforce`)? | Yes; it is the main mitigation for S-3 until the passcode design ships. |

## 7. Implementation order and dependencies
1. **Decisions D1–D9** (blocking).
2. **0019 migration + tests** (`status` columns, creation-time owner trigger, rollback). Depends on nothing.
3. **Application enforcement** (`resolveMembership`, `unit()`, chooser, invitations, workers). Depends on 2.
4. **Platform log** (table, append-only trigger, chain helper reused from `owner-recovery.ts`). Depends on 2.
5. **`academy:bootstrap`** and its tests (needs 2, 4). Unblocks production launch.
6. **Lifecycle and entitlement CLI** (`platform:*`). Needs 2–4.
7. **Documentation, runbooks, rehearsal** of B.7 on a disposable PostgreSQL; PG17/18 full verification; browser spec for a brand-new academy.
8. **Later, only if approved:** web platform console (B step 2).

Independent of Phase 4 but strongly related: the invitation passcode (S-3 option A) should ship **before** the first real Owner invitation
is issued; it changes the Phase 3 tables (0019 can carry it or it becomes 0020).
Phase 5 (cardinality) and Phase 6 (F-02/F-07 integrity) do not block Phase 4.
