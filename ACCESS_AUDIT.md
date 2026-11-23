# Sensitive-data access auditing (Phase 7)

Who looked at sensitive information, when, through what, and whether it was allowed. This is an engineering description, not legal advice.

## What is recorded

One row in `access_event` per logical access (one request that reads one kind of sensitive data):
academy, actor and the role they had, **category**, **operation**, **outcome** (`SUCCESS` / `DENIED`), the record reference (and player reference where there is one), the application operation (`GET reports/:id/pdf`), a per-request correlation id, and a few allow-listed context values (HTTP status, a reason code, counts).
It never holds names, contact details, report or nutrition text, consent text or evidence, allergies, tokens, passwords or authenticator material. `context` goes through `safeContext` (an allow-list) when written and again when read.

| Category | What it covers | Recorded where |
| --- | --- | --- |
| `WORKSPACE` | the academy payload (`GET /api/academy`): players and profiles, guardian links and consent flags, reports and revision history (incl. withdrawn), nutrition plans, allergies/restrictions, family questions, invoices/payments, media metadata, messages, conversations | `bootstrapAcademy` — one event per load with **counts**, never rows |
| `CONSENT` | a player's consent history (`VIEW`); the owner consent report (`BULK`) | `consentForPlayer`, `consentReport` |
| `REPORT` | report PDF (`PDF`); staff opening a withdrawn report (`HISTORICAL`) | `reportPdf` (same transaction) |
| `FINANCE` | receipt PDF | `receiptPdf` (same transaction) |
| `MEDIA` | the file bytes (`DOWNLOAD`) | `readMedia` (same transaction). Issuing the signed link is *not* itself an access, so it is not an event (a refusal is) |
| `TRAINING` | `GET /api/training`: sessions with rosters, observations, goals | `training bootstrap` |
| `ACCOUNT_SECURITY` | the security-event log; the two-factor readiness list | `listSecurityEvents`, MFA overview |
| `AUDIT_LOG` | reading this history (and refused attempts) | `listAccessEvents` |

Operations: `VIEW`, `LIST` (a family member's or narrow-role payload), `BULK` (staff-wide payload or report), `DOWNLOAD`, `PDF`, `HISTORICAL`, `THROTTLED`.
Categories and operations are enforced by database `CHECK` constraints as well as by the code.

## Policies

* **Successful access = transaction-critical, fail-closed.** The event is written before the data is returned — inside the same transaction when the read runs in one (PDFs, receipts, media), so a failed read leaves no event and a failed event rolls the read back. If the event cannot be written the request fails (generic 500) and no data leaves the server. Tested by taking the table offline.
* **Denied access = best-effort, never silent.** A 403/404 on a sensitive read stays a 403/404 even if the record of it fails; the failure is written to the server log (error type only).
* **Denial cap.** Per person, at most 30 denials are itemised per 10 minutes; one `THROTTLED` marker follows, then no more rows until the window passes. Garbage ids are stored as "no id", never verbatim. Unauthenticated requests have no academy and are not recorded here (they never reach the data).
* **No duplicates.** Shared helpers (`reportAccess`, `mediaAccess`, `invoiceAccess`) record nothing; the service function that returns the data records once.
* **Recorded at the service, not the browser or only the route.** The route adds the request id and operation name through `AsyncLocalStorage`; a direct service call is audited too (channel `service`).

## Who may read it

OWNER and ADMIN of the academy (`GET /api/academy/access-events`; Settings → Access history), for their own academy only: the academy comes from the session, every filter is ANDed with it. Filters: kind of information, operation, outcome, person, record/player reference, date range; keyset pagination on `(created_at, id)`, page size ≤ 100. All other roles get 403 (and that refusal is itself recorded). Players are named only for this academy; people only if they are members of it.

## Integrity

* `access_event` is **append-only in the database**: a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`. No route and no service updates or deletes it.
* `actor_id` and `player_id` have no foreign keys on purpose, so the record of who looked survives the removal of an account or a player; only `academy_id` is a foreign key.
* Limits: a database superuser or the table owner can drop the trigger. For real protection run the application with a database role that has only `INSERT, SELECT` on `access_event` (and keep the schema owner separate), and ship the table to write-once storage if your obligations require it. Not enforced by this application (it connects with one role).

## Migration `0008_access_audit`

Additive: one table, four indexes, one function, two triggers. Existing `audit_event`, `security_event`, consent and application data are untouched; nothing is invented for the past (the history starts at deployment). Rollback: `migrations-rollback/0008_access_audit.down.sql` (**destroys the access history**).

## Cost

One small insert per sensitive request (≈1 ms on the embedded database, ≈5 ms on PostgreSQL in the test setup). Storage grows with use: every workspace load is a row (~300 bytes). Indexes: `(academy, created_at, id)`, `(academy, actor, created_at)`, `(academy, player, created_at)`, `(academy, category, created_at)`. Retention is not implemented (see below).

## Not covered / limits

* A workspace load is one event with counts: it does not say *which* players were in it, and a staff user who opens the app has by design "accessed" everything their role may see. Per-record events are created for single-record reads (consent, PDFs, media).
* The browser can display what it already received without a new request; not observable server-side.
* Better Auth's own session/user endpoints (a person's own account data) and sign-in events are covered by the existing security-event log, not here.
* Reading the older `audit_event` (write) history inside the workspace payload is part of `WORKSPACE`.
* Writes remain audited by `audit_event` / `record_revision` / `security_event` / `consent_event` as before.

## Retention and erasure — decisions needed (Phase 8)

No retention period is set and nothing is purged. To confirm with legal/institutional owners: how long access history must be kept (and for what purpose); whether a data subject's identifiers inside it must be erased or pseudonymised on request, and how that coexists with an append-only record; who may export it and in what form; whether the denial cap (30 per 10 minutes per person) is acceptable evidence; and whether the history must be mirrored to storage outside the application database.
