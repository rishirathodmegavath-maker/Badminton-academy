# Account security (Phase 2.2, hardened in Phase 3)

How people prove who they are, and how they get back in, built on Better Auth 1.7.10 (no parallel
authentication system). Everything below is enforced on the server; the pages only make the steps
easy. Scope: password change, owner-authorised reset, temporary passwords, TOTP two-factor
authentication, recovery. Email self-service reset is **not** implemented (no email provider has
been selected) - see "Future work". Sections marked **Phase 3** describe what the hardening pass added
or changed; everything else is unchanged Phase 2.2 behaviour.

## What was built on what

| Need | Mechanism |
| --- | --- |
| Sessions, password hashing (scrypt), rate limiting | Better Auth core (unchanged) |
| Two-factor authentication | Better Auth `two-factor` plugin, TOTP only (no SMS, no email OTP, no provider) |
| Password change, owner reset, forced rotation, sign-in throttle, replay protection, audit trail | `src/modules/identity/account-security.ts`, a Better Auth plugin (hooks + endpoints) |
| "May this signed-in account use the app right now?" | `account-gate.ts`, applied by `resolveActor` (all application APIs) **and** by the plugin (all auth endpoints) |
| Operator recovery | `npm run auth:recover` |

Better Auth's own `/change-password` is switched off in favour of `/account/change-password`: the stock
route lets the client decide whether other sessions survive and cannot clear temporary-password state.
`/request-password-reset`, `/reset-password*`, `/send-verification-email`, `/verify-email`,
`/two-factor/get-totp-uri` and the token-addressed `/revoke-session` are closed too.

**Display names are identity data (Stage 3).** A person's name is copied onto approvals (report `reviewer`, nutrition
plan `professional`, each now stored with the approving account's id), so Better Auth's self-service `POST /update-user`
is refused for every role (`403 PROFILE_MANAGED_BY_OWNER`, recorded as `PROFILE_UPDATE_REFUSED`). An academy owner changes a
name in Settings -> members (`MEMBER_RENAMED` event; the audit row notes `nameChanged`). An approval keeps the name and
account it was made under.

**Signed in is not the same as belonging to an academy (Stage 3).** `resolveActor` answers `403` with a code and a plain
sentence: `NO_MEMBERSHIP` (not assigned), `MEMBERSHIP_INACTIVE` (switched off) or `MULTIPLE_MEMBERSHIPS` (this release supports
one active academy per login). None of them names an academy or identifier, and none grants anything.

## Endpoints (all under `/api/auth`)

| Endpoint | Who | Notes |
| --- | --- | --- |
| `POST /account/change-password` `{currentPassword,newPassword}` | any signed-in person | verifies the current password, applies the policy, refuses reuse, ends **every** session (including the one used) and issues a fresh one |
| `POST /account/admin/reset-password` `{userId,reason,ownerPassword,resetAuthenticator?}` | an `OWNER` | returns the temporary password once |
| `GET /account/security-state` | any signed-in person (even when gated) | what is still required |
| `POST /account/revoke-session` `{id}` | any signed-in person | own sessions only, by id; tokens are never listed |
| `GET /list-sessions` | any signed-in person | id, times, address, user agent, `current` - no tokens |
| `POST /two-factor/enable` / `verify-totp` / `verify-backup-code` / `generate-backup-codes` / `disable` | Better Auth plugin | constrained by hooks below |

## Passwords

* 12-128 characters. No composition rules (NIST SP 800-63B). Rejected: repeated/sequential runs,
  well-known words and their common substitutions (`P@ssw0rd`), the person's email local part or name.
* Must differ from the current password. No history is kept (a deliberate simplification).
* **Current-session policy:** a successful change ends all sessions, including the requesting one, and
  the response sets a brand-new session cookie. A stolen cookie cannot survive the change.
* Changes are compare-and-set: of two simultaneous changes exactly one succeeds (the other gets 409).
* Wrong current password: generic message, counted toward a 10-failure/15-minute per-account lock.

## Owner-authorised reset

Authority comes from the database (`membership.role = OWNER`, active), never from the request or UI.

| Rule | Result |
| --- | --- |
| initiator is not an OWNER (including ADMIN) | 403 `NOT_OWNER` |
| target is the initiator | 403 `SELF` (use change password) |
| target not in the owner's academy, or does not exist | 404 `TARGET_NOT_MEMBER` (identical either way) |
| target is an OWNER | 403 `TARGET_IS_OWNER` (operator recovery only) |
| target also belongs to another academy | 409 `TARGET_MULTI_ACADEMY` |
| missing/short reason (10-500 chars) or owner password | 400 / 403 `REAUTHENTICATION_FAILED` |

Effects, in one transaction: password replaced with a random temporary one, every session of the
target revoked, the target's sign-in throttle cleared, an optional removal of their authenticator,
and a `security_event` row (actor, target, academy, reason, expiry, time). The owner re-enters their own
password. **Policy decision awaiting approval:** peers (owner resetting owner) are intentionally not
allowed; an academy that needs it uses operator recovery.

## Temporary passwords and forced rotation

* 16 symbols (31-symbol alphabet without look-alikes) from `crypto.randomInt`, ~79 bits, shown as
  `XXXX-XXXX-XXXX-XXXX`. Never derived from the clock, a counter or the person.
* Valid 72 hours from issue (`temporary_credential.expires_at`). Only the hash is stored.
* Also used for new members created in Settings (the owner may type one for a hand-over; it is then
  equally temporary). The previous "initialPassword" free-for-all is gone.
* While a temporary password is active the account is **gated**: every application API (academy,
  training, media, PDFs, uploads) answers `403 PASSWORD_CHANGE_REQUIRED`, and every auth endpoint
  except get-session, security-state, sign-out and change-password does too. Path tricks do not help;
  the check is by account state on every request.
* Past expiry the right password no longer creates a session (`403 TEMPORARY_PASSWORD_EXPIRED`, only
  after the password was correct, so nothing is revealed to guessers); an existing session is cut off
  and cannot rotate it. Recovery is a new reset by the owner (or operator recovery).

## Two-factor authentication

* Better Auth plugin, issuer `Sportozen`, 6 digits / 30 s, secret and recovery codes stored
  **encrypted** by the plugin (key derived from `BETTER_AUTH_SECRET`); plaintext never persisted.
* Enrolment: `enable` (password required) issues the secret, QR URI and 10 recovery codes **once**
  (`Cache-Control: no-store`); nothing is active until `verify-totp` confirms a code. Activation ends
  the person's other sessions. The QR is drawn in the browser (`qrcode-generator`, no network calls).
* Sign-in: password gives no session, only a 5-minute challenge cookie; `verify-totp` or
  `verify-backup-code` completes it. Five wrong answers destroy the challenge; ten consecutive failures
  lock the factor for 15 minutes (plugin account lockout); address limit 10/min.
* **Replay protection** (not in the plugin): an accepted authenticator code is single-use per person
  (`totp_used_code`, atomic insert), so the same code cannot open a second sign-in.
* Recovery codes: one use each, regenerating (password required) kills the old set.
* **Trusted devices are refused** (`trustDevice` -> 400): a remembered device would skip the second factor.
* Disable requires the password and ends other sessions.
* No email, no SMS, no provider: nothing external is called.

### Rollout (nothing is mandatory until you say so)

`MFA_ENFORCEMENT` = `off` (default) | `warn` | `enforce`; `MFA_REQUIRED_ROLES` (default: the six staff roles
`OWNER,ADMIN,HEAD_COACH,COACH,FINANCE,NUTRITION_PRO` when the mode is not `off`; guardians and adult players stay
optional). Academy owners can additionally raise this per academy (Phase 4, below). In `enforce`, a required person without
an authenticator can sign in but reaches only the enrolment endpoints until they enrol, so enabling
it cannot lock anyone out. A misspelt value makes authentication fail closed with a clear error (it is never silently ignored). Suggested path: `warn` for
two weeks -> `enforce` for `OWNER` first -> widen.

## Brute-force and rate limits

| Layer | Limit |
| --- | --- |
| per address, sign-in | 5/min (needs `TRUSTED_PROXIES` for real client addresses, see README) |
| per address, change/reset/MFA endpoints | 5-10/min |
| per account, sign-in | 10 failures in 15 min -> 15-minute pause, even for the right password (keyed hash of the email; unknown emails behave identically). **Phase 3:** attempts are *claimed* atomically before the password is checked, so ten is a hard ceiling even for simultaneous requests |
| per account, change-password / owner re-auth | same rule, separate keys per person |
| MFA challenge | 5 guesses per challenge, 10 per account then 15-minute lock |

Trade-off: the per-account pause lets someone who knows an email address delay that one account's sign-in
for up to 15 minutes. It expires on its own, never needs an administrator, and operator recovery /
an owner reset clears it. It cannot permanently lock an owner out.

## Recovery matrix (nobody is locked out, nothing is weaker than login)

| Situation | Path |
| --- | --- |
| Forgot password | Owner resets (reason + own password) -> temporary password -> must replace at once |
| Temporary password expired | Owner issues another |
| Lost phone, has recovery codes | Sign in with a recovery code, then enrol again (disable + enable) |
| Lost phone **and** codes | Owner reset with "also remove authenticator"; MFA required again on next login if the policy says so |
| Used up all recovery codes | Authenticator still works; regenerate codes while signed in |
| Locked by repeated failures | Wait 15 min, or an owner reset / operator recovery clears it |
| Only owner locked out / owner's authenticator lost / owner temp expired | `npm run auth:recover` (operator, below) |

Every recovery still ends at a temporary password that must be replaced, and keeps any authenticator
unless explicitly removed.

### Operator recovery

```powershell
npm run auth:recover -- --email owner@example.com --reason "Owner locked out; identity verified by phone" --yes
# add --reset-authenticator only when the authenticator device AND recovery codes are lost
```

Authority is access to the server's database credentials. Without `--yes` it only names the target.
A database not on this machine needs `MIGRATION_CONFIRM_TARGET=host:port/database` (as for
migrations). The temporary password is printed once. The event is logged with the OS user name.

## Audit trail

`security_event` (append-only): password changes and failures, admin resets and denials, member
credential issue, operator recovery, sign-in locks, expired-credential sign-ins, MFA enrolment /
activation / disable / recovery-code use / regeneration / admin reset. It never contains passwords,
tokens, TOTP secrets or recovery codes (tests search the whole database and the process output for them).
**Phase 3:** it is now shown to owners and admins in Settings -> *Security events* (see below). It is separate from the academy `audit` table (Settings -> *Audit history*), which is unchanged.

## Schema (migration `0004_account_security`)

Additive only: `app_user.two_factor_enabled` (default false) and tables `two_factor`,
`temporary_credential`, `security_event`, `sign_in_throttle`, `totp_used_code`. Existing users, passwords
and memberships are untouched; accounts with no `temporary_credential` row behave exactly as before.
Rollback: `migrations-rollback/0004_account_security.down.sql` (manual, tested; discards enrolled
authenticators and the security log).

## Deployment requirements

* `BETTER_AUTH_SECRET` is now also the key that encrypts authenticator secrets and recovery codes.
  **Changing it after people have enrolled makes their authenticators unreadable** (they would need an
  owner/operator authenticator reset). Treat it as a long-lived secret; plan rotation deliberately.
* `TRUSTED_PROXIES` (README). Without it all clients share each address-based limit, which also
  throttles the MFA endpoints globally (10/min).
* HTTPS `BETTER_AUTH_URL` (secure cookies in production).
* Back up the database before the first hosted migration.
* Optional: `MFA_ENFORCEMENT`, `MFA_REQUIRED_ROLES`.
* **Phase 3:** run `npm run auth:check-config -- --production` with the production environment loaded before deploying (see "Security configuration").

## Phase 3: hardening and administration

### Lifecycle review (what was checked, what changed)

| Stage | State before Phase 3 | Phase 3 |
| --- | --- | --- |
| 1-2 Account creation, first credential | Owner-only (`settings/member`); self sign-up disabled; random 72 h temporary password, hash only | unchanged |
| 3-4 First login, replacing the temporary password | Every application API and every auth endpoint except get-session / security-state / sign-out / change-password answers `PASSWORD_CHANGE_REQUIRED`; expired credentials cannot become sessions | unchanged. A person paused on *change-password* guesses is no longer stuck behind the pause after a reset (below) |
| 5-6 Normal sign-in, password change | Per-address limit, per-account pause, compare-and-set change, all sessions replaced | the per-account pause is now **atomic under concurrency** (below) |
| 7 Failed sign-in and lockout | 10 failures / 15 min -> 15 min pause | policy unchanged; the race that let a burst exceed ten tries is closed |
| 8-9 MFA, MFA recovery | Better Auth two-factor, replay protection, rollout policy | unchanged |
| 10 Administrative reset | Owner only, never self / another owner / multi-academy, re-authentication | also clears the target's *change-password* and *owner re-auth* pauses |
| 11 Session revocation | password change, reset, recovery, MFA enable/disable | **member deactivation now ends all of that person's sessions** |
| 12 Deactivation | the application refuses an inactive member on every route, but their sessions stayed alive | sessions ended at once and a `MEMBER_DEACTIVATED` event is recorded; reactivation and role changes are recorded too |
| 13 Last-owner recovery | `npm run auth:recover` | the command now shows who it is about to recover (name, role, academy, authenticator) before acting, and a recovery clears every per-account pause |

Not changed because they were already adequate: authority for resets, the self/owner/multi-academy
restrictions, forced rotation, MFA gating, session listing without tokens, generic sign-in errors.

### Security events in Settings

`GET /api/academy/security-events` and Settings -> *Security events*.

| Question | Answer |
| --- | --- |
| Who can read it | `OWNER` and `ADMIN` (checked on the server for the signed-in membership; every other role gets the generic 403, anonymous gets 401). **Policy decision awaiting approval:** admins can already manage members; restrict to `OWNER` by editing `SECURITY_EVENT_VIEWERS` in `security-event-log.ts` |
| Which academy | The one on the viewer's membership; no parameter can change it. Events are stamped with the academy when written (the account's single active academy, resolved in `recordSecurityEvent`). Older rows without one are shown only when the person they concern belongs to this academy and to no other. Lockouts for addresses that are not accounts belong to no academy and are never shown |
| What a row shows | event name and plain-language label, outcome (`success`, `failed`, `denied`, `locked`, `refused`), time, who did it and which account it concerned (name and role, only for members of this academy), and an allow-listed set of details: reason text, expiry, number of sessions ended, whether an authenticator was removed, previous/new role, failure count, operator name |
| What is never shown | passwords, hashes, tokens, TOTP secrets, recovery codes, e-mail addresses, raw database columns (`academy_id`, `actor_id`). `detail` is copied key by key through an allow-list with type checks, so something stored by mistake cannot leak |
| Filters | `event`, `outcome`, `person` (a member id, as actor or target), `from`, `to` (instants, inclusive); unknown values are rejected with 422 |
| Paging | newest first, `limit` 1-100 (default 25), opaque `cursor` over (time, id); stable for rows with equal timestamps; `nextCursor` is `null` on the last page |
| Changing or deleting | There is no endpoint, method or code path that updates or deletes `security_event` (tests probe the routes and guard the source). The table is append-only **by application design only**; see limitations |

This is an *account-security* log. It does not record who viewed profiles, reports, PDFs or media
(that is a later phase).

### Atomic per-account limits

The previous flow was *check the lock -> verify the password -> count the failure*. Any number of
simultaneous requests could pass the check before the first failure was counted, so the "ten tries"
ceiling only held for sequential guessing. Now the attempt is **claimed first**: one upsert advances the
counter and the database serialises concurrent claims on that row, so exactly the first ten claims of a
window are judged and the rest are refused with 429 without touching the password. A success clears the
counter; a request that never got a password verdict (malformed) gives its claim back.

Unchanged policy: 10 failures in 15 minutes pause the account for 15 minutes counted from the tenth, even the
right password is refused during the pause, a pause is never extended by further attempts, it ends by
itself, and unknown addresses behave exactly like known ones (including the 429).
The same claim-first rule protects *change-password* (current password) and the owner's re-authentication
for resets, each under its own key per person.

Interaction with the address limits: Better Auth's per-address limiter runs first (5 per minute for
sign-in). A request it refuses never reaches the account counter, so a single address cannot consume an
account's ten tries faster than five a minute, and the account counter is what stops *many* addresses.

### Recovery and resets clear every pause

Installing a temporary password (owner reset, operator recovery, new member) now clears three counters for
that person: sign-in, change-password and owner re-authentication. Before, someone who had been paused on
change-password guesses could receive a temporary password they were obliged to replace and still be
refused for up to 15 minutes. The two-factor plugin keeps its own lockout inside the authenticator
record: it ends by itself after 15 minutes, or immediately if the authenticator is removed (reset with
"also remove authenticator" / `--reset-authenticator`).

`npm run auth:recover` additionally prints the person, role and academy and whether an authenticator is
enrolled (also without `--yes`), so a mistyped address is caught. This is available only to someone
with the server's database credentials and is not an application endpoint, so it cannot be used to probe
for accounts. Authority, safeguards (`--yes`, 10-500 character reason, remote-database confirmation) and
the result (a temporary password that must be replaced) are unchanged.

### Security configuration

`npm run auth:check-config` (add `-- --production` to judge as production) reviews the environment without
starting the app or touching the database, and the same review runs when the server starts
(`src/instrumentation.ts`, skipped during `next build`). **Messages name variables, never values.**

| Setting | Error (production refuses to start; development warns) | Warning / note |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | missing; under 32 characters; in production also fewer than 10 distinct characters or a placeholder-looking value | always a note on rotation consequences |
| `BETTER_AUTH_URL` | missing or not a URL | production and not https |
| `DATABASE_URL` | missing in production | |
| `TRUSTED_PROXIES` | not IP/CIDR entries; **a zero-length prefix (`0.0.0.0/0`, `::/0`)**, which would let any client forge its address | production and unset (every client shares one bucket) |
| `TRUSTED_CLIENT_IP_HEADER` | not a valid header name (when proxies are set) | set while `TRUSTED_PROXIES` is empty (ignored) |
| `MFA_ENFORCEMENT`, `MFA_REQUIRED_ROLES` | unknown mode or role | roles set while the mode is `off` (ignored); a note describing warn/enforce |
| `MIGRATION_CONFIRM_TARGET` | | not `host:port/database` |
| `ALLOW_DEV_SEED` | | `true` in production |

Production failing at start-up is new: previously an invalid proxy or MFA value surfaced on the first
sign-in. Development keeps running and prints the same findings.

**`BETTER_AUTH_SECRET` rotation.** The secret signs session cookies, encrypts authenticator secrets and
recovery codes, and keys the per-account throttle hashes. Changing it (no rolling or dual-key rotation is
implemented): signs everyone out; makes every enrolled authenticator and recovery-code set unreadable, so
those people can no longer pass the second factor until an owner reset with *remove authenticator* (or
`--reset-authenticator` for owners) and re-enrolment; and forgets current pauses. Do it only as a planned
event with owners present, never as part of routine maintenance.

**Trusted reverse proxy.** `TRUSTED_PROXIES` is a statement about your infrastructure that the application
cannot verify, so set it only when all of these are true: (1) the application port is reachable *only*
through the listed proxies; (2) every proxy appends the connecting client's address to the header (the
application takes the right-most address that is not a listed proxy, so forged values to its left are
ignored); (3) the list contains your proxies' own addresses, never a network end users can connect from,
and every hop of a multi-proxy chain; (4) `TRUSTED_CLIENT_IP_HEADER` is set if your proxy uses a different
header. After deploying, sign in from two networks and check that the session list on `/account` (or
`/api/auth/list-sessions`) shows each real address. Unset, forwarding headers are ignored and all clients
share one bucket per endpoint: brute force stays limited whatever headers are sent, at the price that one
attacker can also throttle everyone. None of this has been verified against real hosting infrastructure.

**Safe MFA rollout.** `off` (default, nothing required) -> `warn` -> `enforce`, widening roles in steps.
Enforcement never locks anyone out: a required person without an authenticator can sign in but only reach
enrolment. Suggested order: (1) `npm run auth:check-config -- --production`; (2) owners enrol voluntarily and
store their recovery codes; (3) `MFA_ENFORCEMENT=warn` with `MFA_REQUIRED_ROLES=OWNER` for at least two
weeks; (4) `enforce` for `OWNER`, confirm every owner still reaches the app; (5) widen the role list one step
at a time. Rolling back is setting the mode back and restarting; no data changes. The default roles are the
six staff roles (approved in Phase 4; see the next section for the per-academy policy and staged rollout).

### Decisions still awaiting owner approval

* Who may read the security log (`OWNER` + `ADMIN` today).
* The rollout dates, and when each academy's owners move from *warning* to *required* (nothing is switched on by the software).
* Whether the 15-minute pause policy should change (it did not).
* Whether anyone besides an owner may reset another account (nobody does; admins and peer owners do not).
* The production proxy topology behind `TRUSTED_PROXIES`.
* Refusing to start production on invalid security configuration (new behaviour; development only warns).

### Known limitations (Phase 3)

* `security_event` is append-only by application design; the database does not forbid updates/deletes by someone with direct access. Deployment hardening: give the application's database role `INSERT`/`SELECT` only on that table. Not implemented or verified.
* The log shows account-security events only; reading it is not itself logged.
* A deactivated member can still sign in and use their own password/authenticator pages (the application refuses them everywhere else); role changes do not end sessions because the role is read on every request.
* Events written before Phase 3 for a person who belongs to two academies stay hidden from both.
* The two-factor plugin's own 15-minute lockout is not cleared by a reset that keeps the authenticator.
* Email-based self-service reset is still not implemented.

## Phase 4: two-factor policy and controlled rollout

Phase 2.2 built two-factor authentication itself (TOTP, recovery codes, replay protection, challenge
and lockout limits). Phase 4 adds **who must use it, when, and how that is rolled out safely**. Nothing
becomes mandatory by deploying this: both layers below default to *off*.

### The policy model (one place: `mfa-policy.ts`, applied by `account-gate.ts`)

Per role the answer is a **level**: `optional` (available, nothing asked), `warn` (told to enrol,
access unchanged) or `required` (must be enrolled to use the application; unenrolled people can
still sign in, but only to enrol).

| Role | Default once a mode above *off* is chosen |
| --- | --- |
| OWNER, ADMIN, HEAD_COACH, COACH, FINANCE, NUTRITION_PRO | follow the chosen mode (warn / required) |
| GUARDIAN, ADULT_PLAYER | **optional** (may enrol; asked only if the deployment or an owner adds them) |

Two layers, **the stricter wins per role**:

1. **Deployment** - `MFA_ENFORCEMENT` (`off` default | `warn` | `enforce`) and `MFA_REQUIRED_ROLES`
   (default: the six staff roles above). Set by whoever runs the server. Applies to every academy.
2. **Academy** - chosen by that academy's owner in Settings -> *Two-factor policy* (stored in
   `academy_mfa_policy`, migration `0006`). Same shape. It can only **raise** what the deployment
   sets; it can never lower it.

Evaluated from the database and environment **on every request**, in one place, for the application APIs
and every authentication endpoint alike (so there is no second mechanism to drift). Consequences:

* a role change or reactivation into a required role gates the very next request, including on an
  existing session; a demotion lifts it;
* a new member replaces the temporary password first, then enrols, then has access;
* several active memberships: the **strictest** requirement across them applies (a second membership
  cannot be used to escape one);
* multi-instance deployments agree immediately (policy is in the database; keep the `MFA_*` environment
  identical on every instance);
* a misspelt `MFA_*` value fails closed: authenticated requests are refused (HTTP 500) rather than
  silently ignoring the policy, and production refuses to start (Phase 3 start-up check).

While a role is *required* an enrolled person **cannot turn their own authenticator off**
(`MFA_REQUIRED_BY_POLICY`): with a stolen session plus password, "disable then enrol the thief's device"
would otherwise defeat the policy. A lost device is handled by an owner reset (below) or operator
recovery, both audited.

### Policy administration

| Endpoint | Who | Notes |
| --- | --- | --- |
| `GET /api/auth/account/mfa-policy` | OWNER, ADMIN | policy, per-role level and source, enrolment counts, people who still need to enrol (name, role, whether they hold a temporary password; **no e-mail, no authenticator data**), recovery readiness, enforcement blockers and warnings |
| `POST /api/auth/account/mfa-policy` `{mode,roles,reason,ownerPassword,acknowledgeRisk?,emergencyOverride?,emergencyReason?}` | **OWNER only** | re-authentication with the owner's password (same per-person counter as other owner actions), 10-500 character reason, address limit 10/min; runs in one transaction under the academy lock and re-checks the owner's authority |

Rules enforced by the server (not the page):

* **Staged rollout.** A role can become *required* only if it is already at *warn* (people have notice);
  jumping `off -> enforce` or adding a new role straight to enforce is refused (`WARN_FIRST`).
* The owner making the change must be **enrolled themselves** (`ACTOR_NOT_ENROLLED`) and must
  **acknowledge** the readiness report (`ACKNOWLEDGEMENT_REQUIRED`).
* **Warning period (14 full days, enforced - Phase 4.1).** Before a role becomes *required*, this academy's own
  warning stage must have covered it for at least 14 complete days (`GRACE_PERIOD_ACTIVE`, HTTP 409, until
  `warnSince + 14 days`; exactly 14 days is accepted). Acknowledging the risk does **not** skip it. The clock is
  `academy_mfa_policy.warn_since`, written by the server: a request cannot set it, re-submitting the same roles
  does not touch it, narrowing keeps it, and it can only move *later* - entering warn (from off or required)
  starts it, and adding a role to the warning restarts it, because that role has had less notice. A warning that
  exists only in the server-wide setting (`MFA_ENFORCEMENT`) has no start time, so the academy must start its
  own warning stage first (or use the override). The check runs in the same transaction, under the academy
  lock, as the write, so parallel requests cannot get around it.
* **Emergency override.** Only the academy's **owner** (never an admin) can skip the period, in the same request,
  with `emergencyOverride: true` **and** their own written `emergencyReason` (at least 20 characters, real
  words, not the ordinary reason repeated; `EMERGENCY_REASON_REQUIRED`), after the usual password
  re-authentication, enrolment and risk acknowledgement. A reason or acknowledgement without the flag does nothing.
  Every override writes a `MFA_EMERGENCY_OVERRIDE` security event (actor, academy, time, reason, roles, days actually
  given of the 14) next to the `MFA_POLICY_CHANGED` event, which is marked `emergency`. Nothing is recorded as an
  override when the period was already served.
* Lowering or narrowing is always allowed (reason and password still required). Identical requests change
  nothing and write no event.
* Every change writes a `MFA_POLICY_CHANGED` security event (who, from/to mode, roles, reason) in the
  existing security log, visible to that academy's owners and admins only.
* Advisory, not blocking: a warning if any account in the
  warn stage has not enrolled or still holds a temporary password, and if the academy has one owner (or
  fewer than two enrolled owners), because recovery then depends on the server operator.

### Controlled rollout (nothing is activated for you)

1. Deploy. Everything is still *off*. Run `npm run db:migrate` (backup first; migration `0006` is additive).
2. Owners enrol themselves and store their recovery codes. Aim for at least two enrolled owners.
3. Owner sets **Warning** for the staff roles in Settings -> Two-factor policy. Staff see a notice and the
   *Account security* page explains the change; access is unchanged. Read the readiness list and chase
   the people who have not enrolled.
4. After the 14-day warning period (the server refuses earlier; a recorded owner emergency override is the only
   exception) and when the list is empty, the owner sets **Required** (acknowledging the
   report). Do this for the most privileged roles first if you prefer: choose only `OWNER, ADMIN`, later
   add the others (each must pass through *warn* first).
5. Rollback at any time: set the stage back to *Warning* or *Off*; no data is lost.

Enforcement is **never** switched on by the application, a migration, a default or a test. Switching it on
for existing production users is a decision for your owners to take in step 4.

### Recovery and administrator-assisted reset (unchanged mechanisms, now covered under enforcement)

| Situation | Path |
| --- | --- |
| Lost device, has recovery codes | sign in with a code, then set up a new authenticator (allowed while not required; while required the person re-enrols after an owner reset) |
| Lost device and codes | an **owner** resets the person's password with "also remove authenticator" (reason + the owner's password; admins cannot). Sessions end, the person gets a temporary password, replaces it, and is then required to enrol again |
| Owner lost everything | `npm run auth:recover -- ... --reset-authenticator` (operator with database access) |

The reset records `ADMIN_PASSWORD_RESET` and `MFA_RESET_BY_ADMIN`; a deactivated person cannot be reset.
There is no code path that skips the second factor: a temporary password never bypasses it.

### Production dependencies not verified locally

* Real HTTPS, reverse proxy and `TRUSTED_PROXIES` (address rate limits on the policy and MFA endpoints).
* Identical `MFA_*` and `BETTER_AUTH_SECRET` values on every instance; secret rotation invalidates
  authenticators (see above).
* PostgreSQL 17/18 behaviour of migration `0006` and the new tests (written to run there; run by the
  verifier, not by the author).
* Real authenticator apps and clock drift on users' phones (TOTP window is the Better Auth default).
* The browser flows (Settings panel, notice, account page) have unit/integration coverage of the API only.

## Future work

* **Email-based self-service reset** needs an email provider (not selected). When one exists: add
  `emailAndPassword.sendResetPassword`, re-enable `/request-password-reset` and `/reset-password`
  (currently blocked), keep the same policy, session revocation and per-account throttle, and make the
  email a recovery path that is not weaker than login for MFA accounts (still require the second factor
  or an owner approval). Nothing fake is shipped meanwhile.
* Password history, breach-corpus checking, WebAuthn/passkeys, step-up re-authentication windows.
