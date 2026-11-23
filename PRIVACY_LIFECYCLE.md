# Retention, controlled erasure and legal holds (Phase 8)

An engineering description. **It contains no retention periods and no legal conclusions.** Every category that could be erased is
`REQUIRES POLICY APPROVAL` until the academy's owner approves a rule for it. Finance, consent and audit records are fixed evidence that
this application never erases. Nothing is enabled, scheduled or erased by installing it.

## Scope

The subject of an erasure request is **one player** (a child or an adult player) of one academy. Guardian and staff *accounts* are not erased
by this phase (a guardian's link to the player is deactivated; the account, its security history and its other children are untouched).
Requests are raised by an owner or administrator (recording who asked and how: staff, family request, data-subject request); there is no
family self-service request yet.

## What happens to each category

| Category | Configurable action | What it does | Notes |
| --- | --- | --- | --- |
| Private media and video | ERASE | file removed from storage (after the database commit, via an outbox), row and revisions deleted | existing `expires_at` only blocked access, never removed files |
| Reports and revisions | ERASE | rows and every revision copy deleted | Phase 6 withdrawal only hid reports from families |
| Nutrition (plans, revisions, restrictions, questions, assignments) | ERASE | deleted | |
| Private conversations | ERASE | deleted | |
| Goals and player history notes | ERASE | deleted | |
| Training records | ANONYMIZE | the player's roster name, observations, adjustments and approved observation text are removed from sessions and session revisions; other players' entries stay | |
| Admissions / trial records | ANONYMIZE | name, e-mail, phone, notes, feedback removed; enquiry revisions deleted; the link to the player id stays | |
| Guardian links | ANONYMIZE | deactivated, relationship text replaced | **not deleted**: consent history refers to them |
| Player identity and profile | ANONYMIZE | name becomes "Erased player"; profile blanked and archived; profile revisions deleted | the row stays: consent, invoices and audit refer to its id; done **last** |
| Finance (invoices, payments, refunds, credits) | fixed: kept | counted in the preview | erasure is a legal/accounting decision |
| Consent evidence | fixed: kept | counted | append-only (Phase 5); holds ids, not names |
| Audit, security and access history | fixed: kept | counted | append-only (Phases 3, 7) |
| Broadcast messages and calendar entries mentioning the player | fixed: kept | counted | shared with other families; needs a policy decision |

**Re-identification.** After anonymisation the retained evidence still carries the opaque player id (and, for consent, the guardian's account id).
It no longer resolves to a name, but someone with outside knowledge (amounts, dates, the guardian) could still link it. This is pseudonymisation of
retained evidence, not irreversible anonymisation, and must not be described as the latter.

## Rules (enforced by the server, in one transaction under the academy lock)

* **Retention rules** (`retention_policy`): only the OWNER, with password re-authentication and a written basis. No row = requires policy approval. A rule can be suspended. Evidence categories cannot be given a rule. A rule may carry a number of days after the player left (measured from the newest profile revision once the profile is not active); empty means "on request". Eligibility is evaluated by `evaluateEligibility`; the Settings screen lists players whose period has elapsed but **creates and erases nothing**.
* **Lifecycle** (`erasure_request`): `PREVIEW_READY → GRACE_PERIOD → PROCESSING → COMPLETED`, with `REJECTED`, `CANCELLED`, `BLOCKED` (legal hold) and `FAILED` (explicit, terminal). Every move must be in the transition table; there is no route that executes anything. One open request per player (database unique index).
* **Preview**: built when the request is raised and again at approval, from the real tables (counts only, academy-scoped, no names or contents). Execution re-checks everything again.
* **Approval**: OWNER or ADMIN **other than the person who raised it**, with password re-authentication and a reason. Approval re-evaluates the preview, refuses while a hold applies or while nothing has an approved rule, freezes the plan, and starts the grace period (`ERASURE_GRACE_DAYS`, default 14, bounds 1–365). Cancellation is possible until processing starts.
* **Legal holds**: placed by OWNER or ADMIN (re-authentication, reason), released only by the OWNER. A hold on a player or on the whole academy blocks approval, blocks processing and stops a request in its grace period. Holds are re-checked immediately before every step; a hold that appears mid-run stops the run between steps and the steps already done are reported. Releasing a hold returns blocked requests to review with a fresh preview; they need a new approval.
* **Execution** (`privacy:process` or the button): claims a due request atomically (lock owner + expiry), runs one transaction per category in a fixed order (private files first, identity last), each re-checking status/lock, holds, the rule still approved for the same action, and the player; then removes the recorded private files, appends the **ledger** line, and only then marks the request COMPLETED. Failures are retried with exponential backoff up to 5 attempts, then `FAILED` with a code. A crashed runner's lock expires and the next run resumes (finished steps are not repeated).

## Audit

* `erasure_event`: the request's own append-only history (who, when, why, what; database trigger).
* Security log: `ERASURE_REQUESTED/APPROVED/REJECTED/CANCELLED/BLOCKED/COMPLETED/FAILED`, `LEGAL_HOLD_PLACED/RELEASED`, `RETENTION_POLICY_CHANGED` — references and numbers only, never a name or a reason.
* Access history (Phase 7): reading the overview or a request is recorded as category `PRIVACY`; refusals as `DENIED`.
* Migration `0009` widens the access-history category list by `PRIVACY` (`ALTER` of the check constraint; `0008` is untouched).

## Backups and restores — what is and is not guaranteed

* The **erasure ledger** (`ERASURE_LEDGER_PATH`, JSON lines, synced to disk) records every completed erasure with ids and category names only. It lives **outside the database** so it survives a database restore. `npm run privacy:reconcile` compares it with the database and reports what a restore brought back (exit status 2 when something is found); `npm run privacy:reconcile -- --apply` erases it again, using the categories recorded when the erasure was approved (not the restored database's older rules), including private files, and records it as a `RECONCILIATION` request. **Run it after every restore, before the application is used.**
* In production the ledger location is **required**: without it no erasure completes (it fails and retries with `LEDGER_NOT_CONFIGURED`).
* **Not guaranteed:** the backups themselves still contain the data until they expire or are destroyed; this application cannot delete from them. The ledger protects nothing if it is lost, or stored inside the same backup set as the database it protects — keep a separate, access-controlled, backed-up copy. Legal holds and retention rules created after the backup are lost by a restore (re-create them); the reconciliation does not consult holds. A restored private-media directory brings files back only if their database rows come back too, and reconciliation removes both.

## Operating it

1. Deploy, `npm run db:migrate` (back up first; `0009` is additive and enables nothing).
2. Set `ERASURE_LEDGER_PATH` to a path outside the database's backup set (required in production); optionally `ERASURE_GRACE_DAYS`.
3. The owner reviews each category and approves rules only when the academy's own legal/institutional advice is in place.
4. Schedule `npm run privacy:process` (for example hourly). Without a schedule, erasures run only when someone presses "Process due erasures now".
5. After any restore: `npm run privacy:reconcile`, then with `--apply`.

## Decisions that need people, not code

Retention periods per category and their legal basis; whether an erasure request overrides a retention duty for each category; finance, consent and audit retention and erasure; broadcast messages and calendar entries; guardian and staff account erasure; whether families may submit requests themselves; whether a second approval by the OWNER specifically is required; the grace period length; where the ledger lives and who may read it; how long backups are kept and how they are destroyed.
