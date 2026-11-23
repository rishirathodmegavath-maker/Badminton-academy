# Consent management (Phase 5)

How the academy records, versions, renews and withdraws consent, and who may see or change it. This is an
engineering description. **It is not legal advice and makes no claim of legal compliance**; the questions
that need a qualified adviser are listed at the end, and where the law could go either way the software
offers a configurable, auditable mechanism instead of a hard-coded assumption.

## Model

| Concept | Where | Notes |
| --- | --- | --- |
| Consent categories | `PORTAL`, `EMAIL`, `WHATSAPP` (`consent/domain.ts`) | The existing communication channels. Adding a category (for example media sharing) is a deliberate change: new constant, migration check constraints, flag mapping. |
| Document versions | `consent_policy_version` | Per academy and category, numbered 1, 2, 3 ... A version is a **draft** until an owner/admin publishes it; from then on the database refuses any change or deletion. One open draft per category. |
| Decisions | `consent_event` | **Append-only** history: granted, renewed, withdrawn, lapsed. Each row names the person it concerns (`subject_user_id`), the player, the category, the exact document version presented, who recorded it (`actor_id`, `actor_role`), the relationship on the link at that time (`authority`), the method, the evidence reference, an optional reason, the date the decision states (`effective_at`) and the server time it was recorded (`recorded_at`), plus the previous event. UPDATE and DELETE are refused by a database trigger. |
| Current state | `guardian_link.consent` | Unchanged shape (`portal`, `email`, `whatsapp`). It is the **derived** state that messaging is gated on. It changes only inside the same transaction as the event that explains it (`recordConsentChanges`, the single writer of both). |

Nothing about a player or guardian is copied into the history: rows hold identifiers, not names, contact
details or document text.

### Statuses (per person and category)

`NONE` not given · `CURRENT` given on the version in force (or none is published yet) · `RENEWAL_REQUESTED` still
given, but on an older or unversioned text · `WITHDRAWN` · `LAPSED` ended by a new version that requires renewal ·
`UNRECORDED` the flag says given but no history explains it (pre-history data; shown, honoured as before, reported).

## Lifecycle

* **Give / accept** records `GRANTED` against the version the person was shown. Once a document is published the
  version id **must** be presented (`VERSION_REQUIRED`); presenting a superseded one is refused (`STALE_VERSION`), so a person
  can never accept text they were not shown.
* **Modify** = several categories in one request; each *changed* category gets its own event, unchanged ones none.
* **Renew** = accepting again on a newer version, or the person confirming consent that staff or an import had
  recorded for them: recorded as `RENEWED`.
* **Withdraw** records `WITHDRAWN` (optional reason). The acceptance stays in the history. Withdrawing something not given is a no-op.
* **Duplicates** (the same decision twice) record nothing.
* **Publishing a new version never implies acceptance.** The publisher chooses, per publication, whether earlier
  consent *carries over* (people are asked to review: `RENEWAL_REQUESTED`) or *ends until accepted again* (explicit `LAPSED`
  events attributed to the publisher, `method = SYSTEM_POLICY`, flags turned off, so messaging stops). The software
  does not decide which is lawful; the publisher does, and the choice is recorded on the version and in the security log.
* **Concurrency.** Writes run under the academy lock; `(player, subject, category, sequence)` is unique; a request may carry
  `basedOn` (the sequence it saw) and gets `409 CONSENT_CONFLICT` if the record moved. Event, flag and security event commit or roll back together.

### Methods

`PORTAL_SELF` the person, signed in · `STAFF_WRITTEN` / `STAFF_VERBAL` an owner/admin recording on the person's behalf (an evidence reference is
**required for a grant**, and a database constraint backs it) · `IMPORT_LEGACY` · `SYSTEM_POLICY` (lapse). A decision recorded by staff is shown
to the person as "recorded for you by the academy"; their own later acceptance is a new, separate event.

## Who may do what (server-side, `consent/application/service.ts`)

| Role | Own / linked consent | Everyone's history | Record for others | Documents & report |
| --- | --- | --- | --- | --- |
| GUARDIAN | read and decide for **their own** active link only | no (not even a co-guardian's) | no | read current documents |
| ADULT_PLAYER | read and decide for themselves | no | no | read current documents |
| OWNER, ADMIN | - | yes (their academy) | yes, with method + evidence | create, publish, report |
| HEAD_COACH, COACH, FINANCE, NUTRITION_PRO | **no access** (403) | no | no | no |

* A guardian reaching another family's child, another academy's child or a non-existent id gets the same `404`; a revoked link or a deactivated account ends access at once (history is kept and visible to owners/admins).
* **Adults manage their own consent.** If a player's profile is an adult with their own account, only that person's consent counts: a linked guardian can neither read nor decide, and staff may record only the adult's own consent. No age threshold is built in; "adult" is the existing profile flag plus its own account.
* Coaches no longer receive guardian links or consent flags in the academy payload; finance and nutrition already did not. Head coaches keep link management but **cannot change consent**.
* The academy is always taken from the session, never from the request; a forged `academyId`, `subjectUserId` or actor is ignored or refused.

## API

| Request | Who | Purpose |
| --- | --- | --- |
| `GET /api/academy/consent/<playerId>?limit&cursor` | family (own), owner/admin (all) | statuses, documents in force, history (newest first, paged) |
| `POST /api/academy/consent/decide` `{playerId, decisions:[{category, action:GRANT\|WITHDRAW, versionId?, reason?}], subjectUserId?, method?, evidenceRef?, effectiveAt?, basedOn?}` | family (self); owner/admin (`subjectUserId`, `method`, `evidenceRef` required) | record decisions |
| `GET /api/academy/consent/policies` | family, owner/admin | documents in force (owner/admin also all versions and drafts) |
| `POST /api/academy/consent/version` `{id?, category, title, body}` | owner/admin | create or edit the open draft |
| `POST /api/academy/consent/publish` `{id, requireRenewal}` | owner/admin | publish a draft |
| `GET /api/academy/consent/report` | owner/admin | counts per status and category, who must review or renew, unrecorded flags |
| `POST players/consent`, `POST players/guardian` | unchanged paths | now record history through the same writer (see below) |

`players/guardian`: `consent` is optional (omitted = unchanged; a new link starts with nothing granted); changing it needs owner/admin, `consentMethod`,
`evidenceRef` for grants, and `consentVersions` once documents exist. `players/consent` (family) accepts `versions`.

## Security events

`CONSENT_GRANTED`, `CONSENT_RENEWED`, `CONSENT_WITHDRAWN`, `CONSENT_VERSION_SAVED`, `CONSENT_VERSION_PUBLISHED` in the existing log
(Settings -> Security events; owner/admin of the same academy). Details are limited to category, method, version number, a reference to
the history row and (for publication) the renewal choice and how many consents lapsed. They never contain a child's name, a player id, a reason or document text.

## Existing data (migration `0007_consent_management`)

Additive. For every existing guardian link and every flag that is **true**, one `GRANTED` / `IMPORT_LEGACY` event is created with **no actor, no document
version and no effective date**, `recorded_at` = migration time and a note that who/when/on-what were not recorded. False flags create nothing (we cannot tell
"never asked" from "withdrawn"). Flags are untouched, so no message is gained or lost by upgrading. Rollback script:
`migrations-rollback/0007_consent_management.down.sql` (**destroys the entire consent history and all document versions**; the flags survive).
Fresh-install and upgrade paths are covered by `tests/migrations.test.ts`.

## Operating it

1. Deploy, run `npm run db:migrate` (back up first). Messaging continues exactly as before; existing consents appear as "given before records were kept".
2. Owners/admins draft and publish the documents in Settings -> Consent documents. Choose carry-over or renewal-required at publication (ask your adviser).
3. Ask families to review: in the family portal each person sees the document and gives or withdraws consent; staff can record written/verbal decisions in the player's profile.
4. The report lists who must review or renew, and counts flags without records.

## Limitations and decisions that need people, not code

* **Authority is not verified.** The relationship on a link is self-declared text recorded by staff; the software does not establish that a guardian may legally consent. Treat the history as a record of *what was recorded*, not proof of legal authority.
* **Several guardians.** Each guardian's consent is independent and messaging is per guardian. Whether one guardian's withdrawal must override another's is a policy question.
* **Age and adulthood.** No threshold is encoded. When a player becomes an adult, guardian history remains; the adult's own consent starts from nothing until they give it. A transition workflow is not implemented.
* **Legacy consents** are honoured as before; whether they remain valid, or must be re-confirmed, is a legal/product decision (the report and the `RENEWAL_REQUESTED` state support re-confirmation).
* **Consequences of withdrawal** beyond stopping that channel (for example other data uses) are outside this phase.
* **Retention and erasure** of the history are Phase 8. The database refuses deletion of history, and deleting a person with history is blocked by foreign keys, until Phase 8 designs it deliberately.
* A document is a plain text body per category; there is no language/locale, signature capture, or per-purpose scope beyond the three channels.
* Reading the history is not itself logged (Phase 7).
* Large academies: the owner report reads the latest event per person and category in one query but builds the lists in memory.

## Questions for qualified legal review

Guardian authority and proof of it; children's consent requirements and age thresholds in each jurisdiction; multiple guardians and conflicting decisions;
validity of legacy and carried-over consent after a document change; what withdrawal must stop; how long consent evidence must be kept and when it may be erased; jurisdiction-specific notice or record requirements.
