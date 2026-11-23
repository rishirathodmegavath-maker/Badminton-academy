# Delivery worker: operations, hosting requirements and recovery

Status: built and tested locally with the test adapter and a disposable database. **No production service was configured, no
credential was created, nothing was deployed, and no hosting was purchased.** This document says what production needs so that
the decision can be made.

## What the worker is

`npm run dispatch:worker` (`scripts/dispatch-worker.ts`) is a **separate long-running process**, independent of the browser and of
the web server. Two jobs, one process:

1. **Delivery**: send queued messages (reports by e-mail and the official WhatsApp channel), retry the ones that fail, record
   every outcome.
2. **Scheduled report drafts**: for each academy whose "automatic drafts" rules are on, prepare the drafts that are due
   (monthly, and after N completed sessions). **Drafts only**: nothing is ever approved, published or sent by this job.

The web application only *queues* messages and *shows* their state. If the worker is not running, nothing is lost: messages wait in
the database and go out when a worker starts.

## Run it

```
npm run dispatch:worker                      keep running (delivery every 5 s, scheduled drafts every 15 min)
npm run dispatch:worker -- --once            one pass of each, then exit (cron, one-off, smoke test)
npm run dispatch:worker -- --no-scheduler    delivery only
```

| Variable | Meaning | Default |
| --- | --- | --- |
| `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | the same as the web application (the worker builds report links from `BETTER_AUTH_URL` and signs them with the secret) | required |
| `DISPATCH_EMAIL_PROVIDER` | `none` or `test` | `none` |
| `DISPATCH_WHATSAPP_PROVIDER` | `none`, `test` or `meta` | `none` |
| `WHATSAPP_META_PHONE_NUMBER_ID`, `_ACCESS_TOKEN`, `_APP_SECRET`, `_VERIFY_TOKEN`, `_TEMPLATE`, `_LANGUAGE`, `_GRAPH_VERSION` | the official WhatsApp adapter; inert unless the first five are set | unset |
| `DISPATCH_WORKER_INTERVAL_MS` | delivery pass interval (minimum 1000) | 5000 |
| `DISPATCH_SCHEDULER_INTERVAL_MS` | scheduled-draft pass interval (minimum 60000) | 900000 |
| `DISPATCH_LEASE_SECONDS` | how long a worker may hold a message (minimum 30) | 120 |
| `DISPATCH_TEST_OUTBOX_FILE` | where the test adapter writes what would have been sent | `.data/dispatch-test-outbox.jsonl` |

A channel with no configured provider is **left alone**: its queued messages stay queued, unchanged, and the screen says so.
The test adapter refuses to run when `NODE_ENV=production`.

## Stopping the worker

`SIGTERM`, `SIGINT`, `SIGHUP` (and `SIGBREAK` on Windows) ask the worker to finish the pass in progress and exit with code 0; it
does not wait out its interval. A parent that starts it with an IPC channel (`child_process.fork`) can send the message `"shutdown"`
for the same effect, because Windows cannot deliver `SIGTERM` to a child. A worker killed outright (`SIGKILL`, power loss) leaves
its claimed messages leased; they are recovered after the lease. Verified as real processes in `tests/dispatch-worker-process.test.ts`
(graceful stop by the IPC message; hard kill; two workers; database outage). **The operating-system signal path itself
(`SIGTERM` under a Linux service manager) was not exercised on this Windows machine**: it shares the one `requestStop` function
that the verified IPC path uses.

## Production hosting requirements

- **A database that more than one process can use: PostgreSQL.** The embedded development database (PGlite) allows one process at
  a time, so a separate worker cannot run beside a development server (the screen offers "Process the queue now (test mode)" for
  that, refused in production and refused unless every channel is the test adapter).
- **A place to run one long-lived Node process** that restarts itself: a systemd service, a container with a restart policy, or a
  small VM. One worker is enough for hundreds of families; several may run at once safely.
- **Outbound HTTPS** to the provider(s) chosen. **Inbound HTTPS** for the provider webhook (`/api/webhooks/whatsapp`; an e-mail
  webhook is added with the chosen e-mail provider).
- **Secrets only in the server environment** (never in the database, the repository or logs).
- **Clock accuracy** (NTP): retries and leases are time based.

Not decided and not purchased: the host, the e-mail provider (see `EMAIL_PROVIDER_EVALUATION.md`), the Meta business account and
approved template, and the database service.

## Queue persistence and recovery

- The queue **is the database** (`dispatch_batch`, `dispatch_item`, `dispatch_event`). A restart of the worker, the web server or the
  whole machine loses nothing.
- An item moves `QUEUED → SENDING → SENT → DELIVERED → READ`, or `FAILED_RETRYABLE` (waiting to retry) `→ FAILED`; `SKIPPED` and
  `CANCELLED` are final. "Delivered" and "Read" appear **only** when a provider reports them.
- **Claiming**: items are taken with `FOR UPDATE SKIP LOCKED` and leased, so two workers never take the same item.
- **A worker that dies** holding an item: when its lease runs out, the next pass puts the item back in the queue.
- **At-least-once delivery, stated plainly.** If a worker dies *after* a provider accepted a message but *before* it recorded that,
  the message is sent again after the lease. The window is small (the lease is long) and the idempotency key (the item id) is passed
  to providers that can use it. A duplicate is possible in that single edge; the design never claims otherwise.
- **The duplicate edges, all demonstrated by tests with real worker processes** (`tests/dispatch-worker-process.test.ts`), none hidden:
  a worker killed after the provider accepted a message and before it wrote that down; the database going away at that moment; and a
  *live but slow* worker whose provider call outlives its lease (another worker then takes the item over and the late result is
  refused, but the provider has been called twice). In every case the item ends `SENT` once, with `attempts = 2`, and both calls carry
  the same idempotency key. **Keep the lease well above the provider's own timeout**: the Meta adapter gives up after 15 s and the lease
  is 120 s (`DISPATCH_LEASE_SECONDS`, minimum 30). Nothing here is, or is claimed to be, exactly-once.
- **Retry schedule** for temporary failures: 1 min, 5 min, 30 min, 2 h, 6 h, then `FAILED` after the 6th attempt. A permanent
  failure (an invalid address, a rejected template) fails at once. An owner can retry the failed items of a batch (a suppressed
  address is not retried).
- **Duplicate-send prevention**: one message per address per batch (shared addresses are reached once), and an address that already
  has, or is about to have, a report is not queued it again; pressing "Approve and send" twice cannot double-send.
- **Bounces, complaints and STOP** suppress the address for the people the message was for; the opt-in of a WhatsApp number that
  said STOP is withdrawn.
- **Cancelling a batch** stops what has not been sent and revokes its links. Anything already handed to a provider is not recalled.
- A report that is **withdrawn** after queueing is left out of the message when it is sent; a message with nothing left is
  skipped, not sent.

## Scheduling

The worker prepares scheduled drafts every `DISPATCH_SCHEDULER_INTERVAL_MS`. It acts **on behalf of the person who switched the
rules on**; if that person is no longer an active member who may author reports, the academy is skipped with a note, never run
under someone else's name. It is safe to run as often as wanted and from several workers: it takes an advisory lock per academy and
player and finds the drafts it would have made. Without a worker, the "Prepare the due drafts" button does the same thing.

## Monitoring

- **Worker output** is one JSON line per event with **counts only** (no address, name or message text): `dispatch.worker.started`
  (channel modes and configuration problems), `dispatch.pass` (claimed, sent, retrying, failed, skipped, reclaimed),
  `dispatch.scheduler` (academies, drafts created), `dispatch.worker.crashed`. Collect these with the host's log tooling.
- **Alert on**: no `dispatch.pass` line for several intervals (the worker is down); `reclaimed` greater than zero repeatedly (workers are
  dying or too slow); `failed` rising; items stuck in `QUEUED` while a channel shows as live.
- **The owner's screen** (Reports → Batch reports → Sending history) shows counts per batch and every message's state, with the
  address masked, refreshing itself while anything is moving.
- **Audit**: approving, retrying and cancelling a batch, and changing the draft rules, are audit events with counts, never addresses.

## Failure drill (what to expect)

| Event | Effect |
| --- | --- |
| Worker stopped | Queue grows; nothing lost; resumes on start |
| Worker killed mid-send | Item recovered after the lease; at-least-once edge above |
| Provider down | Items go to `FAILED_RETRYABLE` with growing delays, then `FAILED`; the owner can retry later |
| Database unavailable | A worker that was already running logs `dispatch.pass.failed` (a reason code, never a query), backs off (up to 60 s) and carries on by itself when the database returns, logging `dispatch.worker.recovered`. A worker that never completed a single pass (wrong URL, bad credentials) logs `crashed` and exits 1 for the supervisor to report. Messages that were in flight are sent again once their lease runs out (see at-least-once above) |
| Bad provider settings | The channel shows as not configured; its items wait; the worker logs the problem names (never values) |
| Parent's address bounces | Message `FAILED` with the code; address suppressed for that parent; later batches say why they skipped it |

## Verified and not verified

Verified (local, automated): claiming without double-take, lease recovery, retry/backoff/exhaustion, retry-after-failure,
duplicate prevention, cancellation, withdrawn reports, provider-event ordering and replay, webhook signatures, suppression, the
scheduler's attribution and idempotence. **Not verified**: any real provider (no provider was contacted), PostgreSQL concurrency
under real load (the suite ran on the embedded database; the `FOR UPDATE SKIP LOCKED` claim is standard PostgreSQL), a worker run
as a separate OS process against PostgreSQL, and throughput at 500+ recipients on real infrastructure.
