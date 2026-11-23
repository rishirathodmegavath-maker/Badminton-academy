# Implementation status: contacts, invitations, automated reports and bulk delivery (Badminton)

Date: 2026-11-21. Scope: Badminton only. Football was **not** touched in this milestone. Nothing was committed, pushed, tagged,
merged or deployed. No production data or production database was touched. No paid service was activated, no real credential was
created or used, and no provider was contacted. Design: `DESIGN_CONTACTS_REPORTS_DISPATCH.md`. Operations: `DISPATCH_OPERATIONS.md`.
E-mail providers: `EMAIL_PROVIDER_EVALUATION.md`.

## Decisions followed

| | Decision | Where it shows |
| --- | --- | --- |
| D1 | No login for minors; players are report recipients; contacts independent of identity | `contact_point`; four phone/e-mail combinations tested; no account is ever matched by an address; Better Auth unchanged |
| D2 | No e-mail provider activated; provider-independent interface and a safe test adapter; SES and Postmark evaluated | `providers/types.ts`, `test-adapter.ts`, `EMAIL_PROVIDER_EVALUATION.md`; naming `ses`/`postmark` is refused as "not available in this build" |
| D3 | Design for the official Meta WhatsApp API; nothing activated; free click-to-chat kept as a labelled manual fallback | `providers/meta-whatsapp.ts` (inert without its settings), "Manual fallback: free links (not automatic)" |
| D4 | Minimal, channel-specific WhatsApp opt-in with source, time and revocation | `contact_point.opt_in_*`; gates only the official WhatsApp channel |
| D5 | Secure report links by default; relationship verified | `link-token.ts`, `report-links.ts`, `/report-link`, `/report-links/open` |
| D6 | One message per parent with an individually secured link per child | `plan.ts` `PER_PARENT` (default) and `PER_CHILD`; per-child links in `report_link` |
| D7 | Monthly and after-N-sessions drafts, manual too; drafts only; no duplicates; history preserved | `report-analysis.computeDue`, `policy.ts` |
| D8 | Separate background worker; local build and test; hosting documented | `scripts/dispatch-worker.ts`, `worker.ts`, `DISPATCH_OPERATIONS.md` |
| D9 | Badminton first; Football untouched | Football not modified |

## Migration

`migrations/0019_contacts_dispatch.sql` (journal entry added; guarded rollback `migrations-rollback/0019_contacts_dispatch.down.sql`).
Adds `contact_point`, `report_policy`, `dispatch_batch`, `dispatch_item`, `dispatch_event`, `report_link` and `observation_review.category`.
Purely additive; no existing row changes. **Applied only to disposable local databases**: the test databases, the disposable browser-test
copy, and the local development database behind port 3300 (after a backup, `data\pglite-backup-before-0019`). Not applied to any
production or hosted database. Applying it to a real PostgreSQL database is a step for you to approve.

## Implemented and tested

| Area | Implemented | Verified by |
| --- | --- | --- |
| Migration | 0019 + rollback with reviewed hashes; the 0001–0018 chain tests updated for a new latest migration | `migrations-0019` (7), `migrations` (46 on PGlite), 0013–0018 files |
| Contacts | Per-player and per-parent contacts, same or different values, no merging; WhatsApp opt-in, revoke, parent's own choice; suppression by subject | `contacts` (6) |
| Invitations | Phone and optional WhatsApp opt-in at accept; resend (atomic, old link dies); duplicate message points to Resend; bulk invite per roster line; screens | `invitations-http` (26, 9 of them new today incl. shared phone across two accounts) |
| Report engine | Attendance, practice time by area, reviewed-observation counts by category, previous-period comparison (numbers only), missing-data warnings, required categories, policy, due list, scheduler, advisory-locked draft creation | `report-engine` (6), `report-batch` (5), `monthly-report` (7) |
| Bulk scopes | Academy, batch, selected players; recipients parents / players / both; consolidated or per child; shared address reached once; reasons for everyone left out | `dispatch` plan tests |
| Dispatch engine | Preview, owner-level approve-and-queue, queue, worker with lease, retry/backoff, no double send, retry-failed, cancel, suppression, provider-event ordering/replay, withdrawn-report handling | `dispatch` (13), `dispatch-webhook` (4) |
| WhatsApp (official) | Adapter written to the documented request/response shapes, signed webhook, STOP handling | recorded shapes only, see "not verified" |
| Report links | Unforgeable token, expiry, revocation, withdrawn report, **active parent of that child required** | `dispatch` link test |
| Screens | Batch reports tab: automatic-draft rules and due banner, readiness with missing-data list, recipient and channel choice, preview, approve, history and detail, retry, stop, manual fallback; `/report-link` page | browser tests 4 of 4 |
| Guards | Endpoint surface pinned; transaction allow-list reviewed (worker, webhook); payload snapshot reviewed (`reviews[].category`, staff only) | `auth-endpoint-surface`, `rc2-static-gates`, `role-payload` |

Regression: full Badminton suite 1,054 tests: **910 pass, 27 fail, 117 skipped** (the skips are the PostgreSQL variants that need a
PostgreSQL server). Of the 27, **26 are the three adult-player suites that already fail by design** (`adult-guardian-access` 13,
`rc5-guardian-access-http` 8, `rc5-message-withholding` 5), and **1 was a guard my new code tripped** (the transaction allow-list), now
reviewed and passing. Log: `D:\Sportozen\badminton-main-local\full-suite-2026-11-21.log`. After the suite, the guard and feature files
were re-run and pass (rc2-static-gates, rc5-staff-portal, authority-equivalence, role-payload, auth-endpoint-surface, http-auth,
family-portal-isolation, data-access, report-batch, report-engine, contacts, dispatch, dispatch-webhook).

## Security verification (what was checked, not claimed)

- **Better Auth unchanged**; one new endpoint, `/report-links/open`, pinned in the endpoint-surface test, session required, rate limited, every refusal identical.
- **Relationship, not possession**: a link opens only for an active, signed-in parent of that child with the right to receive reports. Tested: another parent of the same academy, a parent of another child, staff, a user of another academy, an inactive link, a forged/altered/foreign-secret token, an expired link, a revoked link, a withdrawn report.
- **Never another family's report**: each message names and links only its recipient's children; per-child links; a shared phone number is one message, and links still check the relationship per child.
- **No bypass by shared contacts**: nothing looks up an account by address; a parent and a player (or two parents) sharing a value stay separate subjects; opt-in and suppression are per subject (a STOP is by number, deliberately, so a number that said stop is not messaged by any academy).
- **Authority**: queueing, retrying and cancelling need `comms.approve` (owner, administrator, head coach); a coach can preview only their own players; another academy sees nothing; drafts need `reports.author`; policy and approval need `reports.approve`.
- **Webhook**: inert unless `meta` is configured; raw-body HMAC verified before parsing; replay changes nothing; oversized bodies refused; fixed replies only.
- **Privacy**: tokens in URL fragments; audit and logs carry counts and masked addresses, never a full address or report text; the queue stores addresses (needed to send) and a keyed digest for duplicate detection; messages contain links, not report content.
- **Test adapter** refuses production; the dev "process the queue" action is refused in production and unless every channel is the test adapter.

## Deviations from the reviewed design (and why)

1. **No database unique index on reports per period.** The existing suite deliberately creates several reports for one period, and older data could hold duplicates, so a unique index would break both. Instead every automated path takes an advisory lock per academy and player, checks for any overlapping report, and inserts in one step (tested with three simultaneous attempts: one creator).
2. **Approve and queue is one step** (the batch `DRAFT` status exists in the schema but is unused). The report approval already happened; the dispatch approval is the owner's second, explicit confirmation.
3. **`subject_refs` column added to `dispatch_item` while 0019 was still unapplied**, so a bounce or stop is recorded against the people a message was for.
4. **Players cannot open a link by themselves** (no login, D1). A message to a player's own contact says a parent or guardian opens it.

## Not verified (honest list)

- **No real provider was ever contacted.** The WhatsApp adapter matches Meta's documented shapes but has never run against a real account; templates, number registration, business verification and message-category pricing are untested. No e-mail provider adapter exists.
- **PostgreSQL**: all tests ran on the embedded database; the 117 PostgreSQL variants were skipped (no PostgreSQL server here). `FOR UPDATE SKIP LOCKED` claiming and the advisory lock are standard PostgreSQL but unproven here under real concurrency.
- **The worker as a separate OS process against PostgreSQL** was not run; the claim, lease and retry logic is tested in-process (including two simultaneous passes).
- **Throughput at 500+ recipients** was not measured.
- **The parent-facing report page and PDF do not yet show the new analysis lines** (attendance comparison, practice by area); they appear in the coach's studio. Adding them to the published sheet changes what families see and needs your decision.
- **No e-mail unsubscribe link** yet; needed before live e-mail.
- **Real opening of WhatsApp or mail apps** was never exercised, only the links and the test adapter.
- Football alignment (D9) has not started.
