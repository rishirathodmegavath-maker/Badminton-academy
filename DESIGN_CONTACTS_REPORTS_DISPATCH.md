# Player–parent contacts, invitations, automated reports and bulk delivery — architecture and gap analysis

Status: **design for review. Nothing in this document is implemented.** No migration written or run, no provider configured,
no credentials used, no cost incurred, Football untouched. Written 2026-11-21 from a read of the Badminton and Football code
and of public provider documentation. Where a fact comes from outside the code it is marked **[external]** and, where sources
disagreed, **[unconfirmed]**.

This replaces the "not in this step" list in `REPORT_AUTOMATION.md`. The batch-reports screen already built (batch/month picker,
drafts, ready/flagged, owner approve+publish, parent-wise list with free links) stays as the first slice of this design; nothing
below throws it away.

---

## 0. Decisions I need from you before any code (details in section 12)

| # | Decision | My recommendation |
| --- | --- | --- |
| D1 | May a **player (under 18) have their own login**? | No separate login by default. Players are *recipients with contact details*; a parent-supervised player login is an optional later phase. See 2.3. |
| D2 | **Email provider** and sender domain | Amazon SES or Postmark, on a domain the academy owns (SPF, DKIM, DMARC). ZeptoMail already has an adapter in the code. |
| D3 | **WhatsApp**: official Cloud API directly, or through a provider (BSP) | Evaluate with a real Meta business account first; build the engine provider-neutral with a fake provider so nothing waits on this. |
| D4 | **WhatsApp opt-in** record | Required by WhatsApp's own rules. Conflicts with the earlier "remove consent" decision, so a *light* opt-in record is needed for WhatsApp only. See 8.2. |
| D5 | Reports as **links** or **attachments** | Link to the signed-in portal by default; PDF attachment only as an owner-enabled option. |
| D6 | Parent with several children | Default **one consolidated message per parent** with a separate link per child; per-child messages as a switch. |
| D7 | Report triggers | Monthly plus "after N completed sessions", both only ever **draft**; review and approval stay mandatory. |
| D8 | **Where a background worker runs** | Needs a hosting answer (a cron job or a long-running process). Nothing can be queued reliably without one. |
| D9 | When Football is aligned | After Badminton phases 1–3 are accepted; separate approval. |

---

## 1. Current-state gap analysis (evidence)

### 1.1 Badminton today

| Area | What exists | Evidence | Gap against your requirement |
| --- | --- | --- | --- |
| Login identity | One account per email (`app_user.email` unique). Better Auth. | `schema.ts` `email … unique()` | Two accounts cannot share a login email (by design, see 2.2). |
| Phone | `app_user.phone`, E.164 check, **no uniqueness**. Player record has free `email`/`phone` profile fields, no uniqueness. | `schema.ts`, `players/application/service.ts` | Shared phone/email already *works as data*. No dedicated contact model for a player's or parent's contacts before they have an account. |
| Player–parent link | `guardian_link(academy, player, user)`; one parent, many children; one child, many parents. | `schema.ts` | Fine. Needs contact fields on the link or household for parents without accounts. |
| Players' own login | Refused: "Players … are under 18 … invite a parent instead." Adult-player code is dormant/dead. | `invitations/application/service.ts`, tests | Your requirement 1 asks for *separate player invitations*: needs decision D1. |
| Invitations | Token (keyed hash stored), preview, accept by signed-in invitee, status PENDING/ACCEPTED/REVOKED/EXPIRED, one open invite per email (per player for guardians), DB trigger makes ACCEPTED/REVOKED/EXPIRED final, inviter authority re-checked at accept, academy lock, audit + security events. Phone captured at accept (new). | `service.ts`, `migrations/0018` | **Resend** is "withdraw and create again" (manual). No bulk invite. No player invite. Link handed over manually; no queued email. |
| Existing-account linking | Accept by the signed-in account whose email equals the invite; a guardian may gain more children; staff cannot become guardian (409). | `service.ts`, tests | Works. Two roles on one login stays refused (you decided: not needed). |
| Reports | Per-player draft from completed sessions + recorded attendance; coach writes summary/strengths/improvements/priorities; DRAFT→IN_REVIEW→APPROVED→PUBLISHED with versions, history, approver attribution; PDF. **New:** batch drafts, ready/flagged rules, owner batch approve, `facts` sentence. | `reports/application/*`, `REPORT_AUTOMATION.md` | See 1.3 for inputs not yet covered. |
| Report triggers | **None.** Manual only. The server has no timer or job runner. | `instrumentation.ts` (start-up checks only) | Monthly auto-prepare and "after N sessions" need a scheduler (D8). |
| Delivery | `message_draft` + `outbox_delivery(academy,message,user,channel,status,attempts,detail)`, unique per recipient+channel. Email and WhatsApp are **share links** (person presses Send). Optional ZeptoMail transport exists for e-mail. | `schema.ts`, `communications/*` | No queue with leases/backoff for messages, no provider receipts, no batch object, no per-recipient status beyond a row. Not built for 100+. |
| Auth e-mail queue | `auth_email_outbox` with idempotency key, `FOR UPDATE SKIP LOCKED` claiming, backoff, expiry, hashed recipient; worker script. Resend and ZeptoMail adapters. | `schema.ts`, `scripts/auth-email-worker.ts`, `infrastructure/email/*` | A **good pattern to generalise**, but limited to two auth kinds. |
| WhatsApp | Free `wa.me` links only. No provider. | `communications/providers/config.ts` | Official API absent. |

### 1.2 Football today (read only; not modified)

| Area | What exists | Evidence |
| --- | --- | --- |
| Queue | `delivery_jobs` (state, attempts, claim/lease, `UNIQUE(academy, player, guardian, type, period, correction)` = duplicate-send prevention), `delivery_attempts` history, retention job. States include QUEUED, PROVIDER_ACCEPTED, SENT, DELIVERED, READ, FAILED, UNKNOWN. | `migrations/003`, `domain/communication.ts` |
| Worker | `communication-worker.ts` claims jobs, honours academy state and quiet hours, retries with outcome TRANSIENT/PERMANENT/UNKNOWN. | `communication-worker.ts` |
| WhatsApp | Meta Cloud API provider (template bodies, per-academy credential reference, webhook signature, status events). **Dormant**: send and live flags are off. | `whatsapp-provider.ts`, `whatsapp-webhooks.ts` |
| E-mail | Outbox with retry schedule (1m, 5m, 30m, 2h, 6h), 120 s lease, per-recipient hourly cap, Postmark adapter, webhooks. | `email/outbox.ts`, `postmark.ts` |
| Reports | Weekly plans prepared per batch (`weeklyPrepare`, selected players); monthly prepared per player (`monthlyPrepare`); review workspace; approval; share list. | `period-service.ts`, `report-review-workspace.tsx` |
| Contacts | `member_phones` per academy member (no uniqueness across people). `guardian_contacts` has `UNIQUE(academy, phone)` (dormant Meta flow) — **would reject two guardians sharing one number**. | `migrations/016`, `003` |

Football already holds most of the delivery engine in a different shape. It is a *reference*, not code to import: the two apps share no package.

### 1.3 Report inputs: what is recorded vs what you listed

| Input you listed | Recorded today in Badminton? | Gap / proposal |
| --- | --- | --- |
| Attendance and trend | Per-session attendance (PRESENT/ABSENT/EXCUSED/NOT_MARKED). Percent for the month. | Add previous-period comparison (pure arithmetic, no claims). |
| Completed sessions | Yes. | — |
| Drills practised | Yes, with the drill's `skill`. | — |
| Technical / tactical / physical development | Drills carry `skill` (Movement, Overhead, Net play, Serve & return, Defence, Doubles, Fitness) and a catalogue `category`. No development *rating or note* per area. | Map skills to Technical / Tactical / Physical groups for **practice time per group** (a count). Any *judgement* stays coach-written. |
| Behaviour and discipline | Not structured. Observations are free text, private until a coach reviews the wording. | Optional **category tag** on an observation (TECHNICAL, TACTICAL, PHYSICAL, BEHAVIOUR) — stored inside the observation JSON, no schema change. Missing category in a month → flagged, never invented. |
| Coach feedback, strengths, improvements | Yes, coach-written. | — |
| Previous-period comparison | Not computed. | Show attendance %, sessions, practice minutes versus the previous period. **Numbers only; no "improved" wording without a coach statement.** |

---

## 2. Proposed contact and identity model

### 2.1 Principle
Never merge or match people by phone or email. A login account is identified by its account id. A *contact* is only a place a message may be sent. Equality of two contacts means "send once to that address", never "same person".

### 2.2 What can and cannot be independent
- **Contact details** (where messages go): fully independent. Same phone/same email, same phone/different email, different phone/same email, different/different — all four are plain values with no uniqueness rule. Already true for data fields; the design makes it first-class and testable.
- **Login identity**: Better Auth requires a unique email per account. Two *accounts* therefore cannot share a login email. This is an authentication fact, not a contact rule. It is why the player question (D1) matters.

### 2.3 Players under 18 (decision D1)
| Option | Meaning | Consequence |
| --- | --- | --- |
| A (recommended) | Player has **no login**. Player contact email/phone are recipient details. Reports reach the player only through contact delivery or through a parent. | No new account type, no identity collisions, smallest minor-safety surface. |
| B | Optional **player login** under a *different login email*, linked to the player record, read-only (own schedule and published reports), created through a parent-authorised invitation. | Needs its own role, own authorization tests, parent consent, and the player must have an email of their own. Shared contact email still possible for *delivery*, never for the login. |
| C | Player login with the same email as the parent | **Not possible** with one-account-per-email, and not recommended. |

### 2.4 Proposed structures (additive; need migration approval, see section 9)
- `contact_point` — `id`, `academy_id`, `subject_kind` (PLAYER | GUARDIAN_LINK | ACCOUNT), `subject_id`, `channel` (EMAIL | WHATSAPP | SMS-reserved), `address` (normalised: lower-case email or E.164), `label`, `verified_at` (null until proven), `opted_in_at` + `opt_in_source` (for WhatsApp), `suppressed_at` + `suppression_reason` (bounce, complaint, stop). **No uniqueness on address across subjects.** Composite foreign keys to the academy like the existing tables.
- Existing `app_user.phone` and account email stay as account facts; `contact_point` rows may be seeded from them.
- Delivery de-duplication happens at send time on `(channel, normalised address)` **within one dispatch batch and one content scope**, by policy (D6), and is always shown to the owner ("2 recipients share this number: sent once").

---

## 3. Invitation lifecycle

States (existing): PENDING → ACCEPTED | REVOKED | EXPIRED, final states enforced by a database trigger.

Proposed additions, none of which weakens the existing rules:
1. **Resend** = one atomic action: revoke the open invitation and create a fresh one (new token, same role/player/relationship/phone), rate-limited, audited, old link dead immediately.
2. **Duplicate handling**: keep "one open invitation per email (and per player for guardians)"; a second attempt returns the existing open one's state with a *Resend* option instead of a bare refusal.
3. **Bulk invite**: from a roster list (player, parent name, parent email, parent phone, relationship) creating one guardian invitation per parent row; a parent with several children in the list gets one invitation per child that links to one account at accept (this already works at accept).
4. **Existing account linking**: accept by signed-in email equality (unchanged). Never create or merge an account from contact equality.
5. **Player invitation**: only if D1 chooses option B; kind `PLAYER`, linked to one player, requires a parent-authorised, parent-created invitation, expiry shorter than staff invites, read-only role validated server-side exactly like the guardian kind.
6. **Delivery of the invitation**: free links remain; queued e-mail delivery arrives with the dispatch engine (phase 4) using the same outbox.
7. Tokens stay 256-bit, stored as keyed hash, shown once, carried in URL fragment/body only. Role is never chosen by the invitee. Inviter authority is re-validated at accept.

---

## 4. Report-generation architecture

Pipeline (each step pure and testable; the first two already exist):
1. **Assemble** facts for (player, period) from recorded sessions, attendance, drills and *reviewed* observation wording.
2. **Judge** with `reportIssues` (extended): attendance not marked, no present session, a required coach section empty, **and new:** no observation in a category the academy requires, previous period missing (shown as "no comparison available").
3. **Compare** with the previous period: numbers and deltas only.
4. **Draft** into the ordinary report record. The coach's words are never generated. `facts` and comparison lines are labelled "from the records".
5. **Review** (coach edits) → **Approve** (owner-level, batch or single) → **Publish**. Mandatory before any parent/player delivery; delivery reads published reports only.

Triggers (all produce **drafts only**):
- Manual: the existing Batch reports screen.
- Monthly: the day after month end, per academy policy.
- Every **N completed sessions** per player (N configurable per academy, e.g. 8).
- A *due check* function `reportsDue(academy)` is pure and computed on demand (the owner sees "12 reports due" when opening Reports). A scheduled job calls the same function to create the drafts without anyone opening the page. The job needs a runtime (D8); without it the due list still works, only unattended creation does not.

Settings: a small `reportPolicy` block (period type, N, auto-draft on/off, required observation categories) in academy settings JSON — no new table.

Duplicate protection: today a code check. Proposed: a unique partial index on (academy, player, period start, period end) for non-withdrawn reports (needs migration approval) so concurrent triggers can never double-create.

Missing data is always **flagged and listed**, never filled in.

---

## 5. Bulk generation and recipient scopes

Scopes: entire academy, selected batch, selected players (all exist in the batch screen); *linked parents*, *players only*, *parents only*, *players and parents* are **recipient modes** chosen after reports are approved (section 6).

Rules:
- Generate for every eligible player, skip those without evidence with a reason (exists), never duplicate (exists in code; unique index adds DB-level safety).
- A parent with several children: **consolidated** (one message, a labelled link per child) or **separate** (one message per child), chosen per batch (D6). Both name each child clearly; neither merges children's content.
- Players-only or players-and-parents: a player recipient needs a player contact (`contact_point`); a player without one is listed as "no contact", never silently dropped.

---

## 6. Bulk delivery architecture

### 6.1 Objects (additive; migration approval needed)
- `dispatch_batch` — academy, kind (REPORT | ANNOUNCEMENT | INVITATION), period, recipient mode, channels, consolidation mode, created by, **approved by/at** (the owner's batch approval), totals by status, status.
- `dispatch_item` — one row per (batch, recipient, channel): recipient reference and a *hashed* address for logs, the report ids it carries, **idempotency key** with a unique index on (batch, recipient hash, channel) → duplicate-send prevention, status, attempts, `next_attempt_at`, lease, provider message id, last error code, timestamps.
- `dispatch_event` — append-only provider receipts (accepted, sent, delivered, read, failed, bounced, complained, stop), signature-verified at the webhook.
- Existing `audit` and security-event tables record who approved, dispatched, retried or cancelled.

### 6.2 Flow
`Approved batch → expand recipients (apply scope, de-duplicate shared contacts, skip suppressed/unsubscribed/no-contact, show counts) → preview exact text for a sample and the totals → owner dispatches → items QUEUED → worker claims with FOR UPDATE SKIP LOCKED, lease, rate limit per provider → provider call → SENT/ACCEPTED → webhook updates DELIVERED/READ/FAILED → retry with backoff only for retryable errors → terminal states`.

The pattern already exists twice: `auth_email_outbox` (Badminton) and `delivery_jobs` + email outbox (Football). The design generalises Badminton's.

### 6.3 Statuses shown to the owner
`Generated → Reviewed → Approved → Queued → Sent → Delivered → Failed` (with Retrying and Skipped, each with its reason). **"Delivered" appears only when the provider reports it.** With no receipt the status stays "Sent (accepted by provider)". Free manual links keep today's honest wording: "Opened" means a button was pressed.

### 6.4 Scale
100–500 recipients is small for a queue: a worker draining a few messages per second finishes in minutes. The limits are the providers' (below), not the database. A load test with 500 fake recipients is an acceptance test.

### 6.5 Links versus attachments (D5)
- **Link** to the signed-in portal: nothing personal travels in the message; revoking access revokes the report; works for e-mail and WhatsApp.
- **PDF attachment**: copies a minor's data into mailboxes permanently and can be forwarded; allowed only as an explicit owner option with a plain warning. WhatsApp document templates are possible but have template-approval implications **[unconfirmed]**.

---

## 7. External providers, requirements and costs (no account opened, nothing configured)

### 7.1 E-mail
| Option | Cost (published, **[external]**) | Notes |
| --- | --- | --- |
| Amazon SES | about $0.10 per 1,000 e-mails on most 2026 sources; the AWS page lists $0.16 for the first tier **[unconfirmed which applies]**; attachments extra | Cheapest; you manage reputation and domain setup. |
| Postmark | from $15/month for 10,000 e-mails | Strong deliverability; Football already has an adapter. |
| Resend | free tier 3,000/month; Pro about $20 for 50,000; overage figures disagree between sources **[unconfirmed]** | Simple; Badminton already has an adapter. |
| ZeptoMail | pricing not verified here | Badminton already has an adapter. |
| **Gmail** | Google's help pages describe sender rules; the commonly quoted daily caps (500 personal, 2,000 Workspace) come from third-party pages **[unconfirmed]** | **Not recommended for bulk**: personal limits, bulk-sender rules above 5,000/day, ties delivery to one person's mailbox. You also asked not to assume it. |

All real providers need an **owned sender domain** with SPF, DKIM and DMARC, plus bounce/complaint handling and an unsubscribe path. Google states SPF/DKIM for all senders and DMARC for bulk senders **[external]**.

### 7.2 WhatsApp Business Platform (official)
Requirements **[external]**: a Meta business account, a WhatsApp Business Account, a dedicated phone number, business verification for higher limits, **templates approved by Meta** for any business-initiated message outside a 24-hour customer-service window, and **recorded opt-in** from each recipient. Templates are classed marketing, utility or authentication, and each is billed per delivered message **[external]**.

Costs: India rates quoted by third parties — utility about ₹0.13–0.145, marketing about ₹0.86–1.09 per delivered template **[unconfirmed: third-party figures that may include provider mark-ups; sources also disagree on whether utility templates inside an open window are free and on a possible change from 1 October 2026]**. Confirm on Meta's rate card in Business Manager before budgeting.

Illustration only: 100 families × 12 monthly reports = 1,200 messages a year ≈ ₹160–₹175 if classed utility, ≈ ₹1,000–₹1,300 if classed marketing, plus any provider fee. **Meta, not the academy, decides the classification**; a report-ready notice is likely utility but that is not guaranteed.

Other limits **[unconfirmed]**: sending tiers depend on verification and quality; template creation is rate-limited; a flagged or low-quality number can be restricted. Free `wa.me` links remain a manual, one-person-at-a-time fallback and will never be labelled automatic.

### 7.3 What this design needs from you
A chosen e-mail provider and domain, and a Meta business account if WhatsApp is wanted. Until then the engine is built and tested against a **fake provider**, so nothing is blocked and nothing is paid.

---

## 8. Security and privacy (players are minors)

1. **Academy isolation** unchanged: every new table carries `academy_id` with composite foreign keys; every action re-checks the actor's academy and capability under the existing `unit()`.
2. **Authority**: drafting needs `reports.author`; approving `reports.approve`; dispatch needs a new `dispatch.send` capability held by the owner by default. A coach never dispatches.
3. **Opt-in versus the "remove consent" decision.** You removed consent gating for ordinary sharing. WhatsApp's platform rules still require opt-in for business-initiated messages **[external]**. Proposal: capture a one-line opt-in when a parent accepts an invitation (or is entered by the owner with a source), stored on `contact_point`, used **only** to decide whether the official WhatsApp channel may be used. It does not bring the old consent module back. E-mail needs a suppression list (bounce, complaint, "stop") and an unsubscribe path.
4. **Minors' data**: messages carry no report content, only a link to a signed-in page; child names are used only where needed (first names, as today); no PDF attachments by default; logs and delivery records store hashed addresses, as `auth_email_outbox` does.
5. **Applicable law**: children's data rules (for example India's Digital Personal Data Protection Act 2023, which has special rules for children) may require verifiable parental consent. This is not legal advice; it needs your counsel before the system is used with real families.
6. **Tokens and links**: invitation tokens as today; report links are portal sign-in links, not bearer URLs, so a forwarded message exposes nothing.
7. **Webhooks**: signature-verified, replay-safe, idempotent per provider event id.
8. **Secrets** only in server environment, never in the database or logs; no secret is created or read as part of design.
9. **Audit**: batch approval, dispatch, each retry, cancellation and suppression are audit events with actor and counts, not addresses.
10. **Retention**: delivery items and events kept for a defined period (Football uses 90 days for e-mail) then removed; the audit trail stays.

---

## 9. Migration requirements

| Change | Badminton migration (new, `0019+`) | Notes |
| --- | --- | --- |
| `contact_point` table | yes | additive |
| `dispatch_batch`, `dispatch_item`, `dispatch_event` | yes | additive; indexes for claiming and idempotency |
| Unique index on non-withdrawn report per (academy, player, period) | yes | additive; needs a pre-check that no duplicates exist |
| Opt-in/suppression columns | within `contact_point` | no change to existing tables |
| `reportPolicy`, observation category | **no** | live in existing JSON columns |
| Invitation resend, bulk invite | **no** | code only |

Each migration needs a guarded down script and updated migration tests, as 0016–0018 did (the existing 0018 rollback test requires 0018 to be the latest, so those tests change). **Nothing is run without your approval, and never against production.** Football would need its own, separately approved, changes (its `guardian_contacts` unique phone is the one rule that conflicts with shared numbers).

---

## 10. Phased implementation with acceptance tests

| Phase | Scope | Acceptance tests |
| --- | --- | --- |
| 0 | Decisions D1–D9; provider choices; hosting for a worker | Signed-off decisions. |
| 1 | Contact model; the four contact combinations; invitation resend/duplicate/bulk; (player invite only if D1=B) | All four phone/email combinations store and deliver independently; equal contacts never merge accounts or roles; resend kills the old link at once; expired/revoked/used links refused; a parent of three children ends with one account and three links; cross-academy invitation refused; role cannot be chosen by the invitee. |
| 2 | Report engine v2: category tags, practice-time groups, previous-period comparison, `reportPolicy`, `reportsDue`, extended issues | No text is generated for coach sections; every missing input is flagged; comparison shows numbers only; due list matches fixtures for monthly and N-session triggers; duplicate trigger creates one draft. |
| 3 | Bulk scopes and recipient modes; consolidated vs separate; preview of exact text and totals; owner batch approval gate | A parent with 3 children gets one consolidated message with three labelled links, or three separate messages, per mode; shared contact receives one message and the owner sees why; players-only without contacts lists "no contact"; nothing dispatches before approval. |
| 4 | Dispatch engine with queue, worker, idempotency, statuses, retry, audit, **fake provider**; then e-mail through the chosen provider | 500 fake recipients drain without duplicates; a killed worker's items are reclaimed; retryable failure retries with backoff, permanent failure does not; re-pressing dispatch creates no second message; statuses never say Delivered without a receipt; bounce suppresses the address. |
| 5 | Official WhatsApp integration | Template approved; opt-in required and checked; webhook signature and replay tests; status mapping; free-link fallback still labelled manual. |
| 6 | Monitoring screen, retry-failed button, history and export | Owner sees counts by status, filters failures, retries only failed items, audit lines exist. |
| 7 | Football alignment | Separate approval and plan. |

Every phase keeps: authentication, academy isolation, authorization, report history, approval and audit rules, with the existing suites as regression gates.

---

## 11. What stays as built

The Batch reports tab, the ready/flagged rules, owner batch approve+publish and the parent-wise free-link list remain. In the new design the same screen becomes steps 1–6 of your workflow, and "Send to parents" gains a second path (queued dispatch) beside the free-link list rather than replacing it.

## 12. Decision details

- **D1** is the biggest. Option A means the "player" in "players and parents together" is a contact recipient. Option B adds an account type and needs parent-controlled creation, and requires the minor to have an email of their own.
- **D2/D3** are provider purchases. I will not open or configure any account.
- **D8**: without a place to run a worker or schedule, unattended monthly drafts and queued dispatch cannot run. Options: a scheduled job on the host, a long-running worker process (as `auth:email-worker` already is), or a managed queue.
- **D4**: if the answer is "no WhatsApp API", the WhatsApp phase is dropped and links remain manual.
