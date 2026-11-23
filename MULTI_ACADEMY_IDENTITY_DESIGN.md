# Multi-academy identity: design for approval (Phase 2, findings F-03 and F-04)

Status: **design only. Nothing in this document is implemented.** Phase 1 (F-01) is implemented and verified separately.

## 1. Principle

*Authentication identifies the person. Authorization is evaluated against one membership in one academy, resolved on the
server for every request.* No client-supplied academy id is ever used for authorization; the client may only ASK to switch,
and the server checks that the person holds an active membership there.

## 2. What exists today (evidence)

| Where | Today |
| --- | --- |
| `membership` PK `(academy_id, user_id)` | already many-to-many; no change needed |
| `resolveActor` (identity/access.ts:17-76) | refuses 2+ active memberships: `403 MULTIPLE_MEMBERSHIPS` |
| Better Auth plugin endpoints (account-security.ts:385, 434, 508, 578, 663, 721; mfa-admin.ts:279) | each re-derives "exactly one membership" on its own |
| `accountGate` (account-gate.ts) | **already** takes all active memberships; the strictest MFA requirement wins |
| `resetDecision` (reset-policy.ts) | refuses a target who belongs to another academy (`TARGET_MULTI_ACADEMY`) |
| owner restore (owner-recovery.ts:94-100) | refuses an account with 2+ memberships |
| `soleAcademy` (security-events.ts:71) and `onlyHere` (security-event-log.ts:131) | account-level events of a multi-academy person get `academy_id = NULL` and are hidden from every academy |
| Owner save (settings/service.ts) | `update(t.user).set({name})`: renames the global identity |
| Member deactivation (settings/service.ts) | `delete(t.session).where(userId)`: ends the person's sessions in every academy |
| `lockActor` | re-validates (academy, user, role, active) under the academy lock: **reused unchanged** |

## 3. Active-academy mechanism

**Decision D1: a separate table, not a column on Better Auth's session.**

```
auth_session_academy
  session_id  text PRIMARY KEY REFERENCES auth_session(id) ON DELETE CASCADE
  user_id     text NOT NULL
  academy_id  text NOT NULL
  selected_at timestamptz NOT NULL DEFAULT now()
  FOREIGN KEY (academy_id, user_id) REFERENCES membership(academy_id, user_id)
```

Why: it does not alter Better Auth's own session schema or plugin contract; the row disappears with the session (sign-out,
expiry, password change all clear it); the composite FK means a selection can only ever name a membership that really
exists; the academy id never travels in a cookie or header.

**One shared resolver** (`resolveActiveMembership(userId, sessionId)`), used by `resolveActor` AND by every plugin endpoint
that today says `own.length !== 1`:

1. Read the person's ACTIVE memberships whose academy is not closed (joined to `academy`; Phase 4 adds the status).
2. Read the session's selection row.
3. Selection exists and matches an active membership: use it. Selection exists but is stale (membership deactivated):
   ignore it and delete the row.
4. Otherwise exactly one active membership: use it (no row needed).
5. Otherwise none: `403 NO_MEMBERSHIP` / `MEMBERSHIP_INACTIVE` (unchanged codes).
6. Otherwise several and none chosen: `409 ACADEMY_SELECTION_REQUIRED`. The body carries no academy data.

Every request repeats steps 1-6, so a revoked membership takes effect on the next request. `lockActor` still re-validates
inside the write transaction, so a request that resolved before a revocation is refused at commit time.

**Endpoints (Better Auth account-security plugin, so they work before an academy is chosen):**
- `GET /account/academies`: the person's own active memberships: academy name, role, whether it is the current one.
  Nothing about any other person or academy.
- `POST /account/select-academy {academyId}`: checks the active membership server-side, upserts the selection row,
  records `ACADEMY_SELECTED` (account-level event naming the target academy), rate limited.
  Subject to `accountGate`: a gated session (temporary password, required MFA enrolment) cannot switch.
- Switching does not end the session: it is the same authentication. It re-runs the gate and changes only which
  membership later requests resolve to.

**Client:** a `409 ACADEMY_SELECTION_REQUIRED` sends the browser to `/academies`. Zero memberships shows the "no academy
yet" screen (Phase 3 adds pending invitations to it). One membership continues exactly as today. The active academy's
name is always shown in the shell, with a switch control when the person has more than one.

## 4. Decisions on the identity side effects (F-04)

| # | Topic | Decision |
| --- | --- | --- |
| D2 | **MFA with different requirements** | Keep the existing contract: the strictest requirement across **all** active memberships applies, because the authenticator belongs to the person, not the academy. `resolveActor` passes all memberships to `accountGate` (today it passes only the selected one). |
| D3 | **Names** | New nullable `membership.display_name`. An Owner's rename writes only that. `user.name` stays the person's global name (set at creation) and is no longer overwritten by an academy Owner. The resolved actor name is `display_name ?? user.name`, so approvals and audit show the same name as before for existing data. Self-service editing of the global name is a separate product change, not part of this phase. |
| D4 | **Deactivating or removing a membership** | Delete only that person's selection rows pointing at that academy. Their sessions and their other academies are untouched. Only when **no active membership remains** are all sessions ended (today's behaviour, so single-academy people see no change). `MEMBER_DEACTIVATED` records which of the two happened. |
| D5 | **Owner-initiated password reset of a multi-academy person** | Keep the refusal. The credential is global, and one academy must not cut a person off from another. The message points to the two correct paths: the person's own email recovery (verified accounts), or operator account recovery. |
| D6 | **Operator owner restore** | Requires `--academy <id>` when the person has several memberships. It restores the OWNER role in that academy **only**; it issues no temporary password and revokes no sessions for such a person. If credentials were also lost, the operator runs the separate account recovery, whose dry run now lists every academy the person would lose sessions in. Single-academy people: behaviour unchanged. The existing two-operator approval, 24 h expiry and hash-chained log are untouched. |
| D7 | **Security-event visibility** | Account-level events (password change, authenticator change, lockout, selection) are recorded with no academy and shown to **every academy where the person is an active member**, with allow-listed detail that names no other academy. Academy-scoped events (`MEMBER_*`, privacy, consent) stay academy-only. This replaces the hide-from-everyone rule for multi-academy people. |
| D8 | **Self-service password recovery** | Rules are already global (verified, has a password, **no OWNER membership anywhere**); unchanged. |

## 5. Migration 0017 (additive, no existing row changes)

```
CREATE TABLE auth_session_academy (...)            -- section 3
ALTER TABLE membership ADD COLUMN display_name text
  CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 120);
```

- No backfill, and nobody gets a membership or a selection. A person with one membership sees no difference.
- Guarded rollback in `migrations-rollback/0017_*.down.sql`, following 0013-0016: refuses while any `display_name` is
  non-null unless explicitly forced; drops the table. A migration test on PGlite and PostgreSQL 17 and 18 pins the shape,
  the composite FK and the rollback.
- The journal currently ends at `0016_guardian_phone`; I will re-check the tail immediately before creating the files,
  because other sessions also write migrations.

## 6. Order of work inside Phase 2 (each step verified before the next)

1. Migration 0017 + rollback + migration tests (PGlite first; PostgreSQL 17/18 at the end of the phase).
2. `resolveActiveMembership` + `resolveActor`; `/account/academies`, `/account/select-academy`; unit and HTTP tests.
3. Convert the five `own.length !== 1` endpoints and `mfa-admin.ts:279` to the shared resolver.
4. Side effects: D3 (display name), D4 (deactivation), D2 (gate), D7 (event visibility).
5. Recovery: D5 message, D6 `--academy`, account-recovery dry run listing.
6. UI: `/academies`, zero-membership screen, shell academy name and switcher, 409 handling.
7. Browser test for selection and switching; PostgreSQL 17/18 for the migration and HTTP suites.

## 7. Tests (focused; RC1-RC5 evidence reused, not rerun)

- Two memberships: no selection gives `409`; selecting works; each academy's data is reachable only while selected and
  never both at once; a forged or other-person `academyId` is refused; a stale selection falls back safely.
- Revocation: deactivating A while a request for A is waiting is refused (`lockActor`); the person's B access and
  sessions survive; deactivating the last membership ends every session.
- Different roles per academy (Owner in A, Guardian in B): each resolves its own authority; nothing leaks across.
- MFA: a required policy in either academy gates the person everywhere until enrolled.
- Names: an Owner's rename changes only the display name; the global name and the other academy are unchanged.
- Recovery: D5 refusal message; D6 role-only restore keeps the person's credentials and other sessions; single-academy
  restore unchanged.
- Events: account-level events visible to both academies, none leaking the other academy's name.
- `membership-resolution.test.ts` currently pins `MULTIPLE_MEMBERSHIPS`; it is rewritten to the new contract.
- Concurrency: switching while an Owner demotes or deactivates the person; last-Owner protection (reuses
  `owner-concurrency` evidence).

## 8. Compatibility and risk

- Single-academy people: identical behaviour (no selection row, same codes, same session handling).
- Existing tests that assert `MULTIPLE_MEMBERSHIPS`, rename-writes-`user.name`, and deactivation-ends-all-sessions change
  deliberately and are listed in the phase report.
- No change to Better Auth tables, Google or password sign-in, signup, TOTP, or the Owner-presence trigger.
- Not in this phase: invitations (Phase 3), platform authority and academy status (Phase 4), self-service global name.
