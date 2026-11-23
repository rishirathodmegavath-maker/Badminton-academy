# Adult-controlled guardian access (RC-4)

How a guardian's access to a player changes when the player becomes an adult, and how the adult decides what each
guardian may see. Engineering description of what the code does; it is not legal advice.

## The rule

| Player | Guardian with an active link sees |
| --- | --- |
| Minor (profile `adult: false`, no own account) | Everything a family sees today. Unchanged. |
| Adult (profile `adult: true`) | **Nothing**, until the adult grants it; then only the granted sections. |

* Only the signed-in **adult player** (the account the player's profile names as `selfUserId`) can grant, change or
  revoke. Staff cannot, the owner cannot, a guardian cannot, and there is no system or import path that grants.
* Each guardian is authorised separately and can hold a different combination.
* An adult with no account of their own cannot be granted for by anyone: guardians see nothing until the adult has an
  account and grants access.
* Guardian links and consent records are never deleted or rewritten by any of this.
* Consent is **not** a section. A guardian has no consent authority over an adult player with any combination of
  sections.

## The seven sections

| Section | Opens |
| --- | --- |
| `SCHEDULE` | training sessions, attendance, calendar events |
| `REPORTS` | published reports and the report PDF |
| `NUTRITION` | shared nutrition plans |
| `HEALTH` | allergies and restrictions (read and update), private nutrition questions |
| `FEES` | invoices, payments, refunds, credits, the receipt PDF, submitting a payment |
| `MEDIA` | shared photos and videos (link and file download) |
| `MESSAGES` | portal messages, delivery records, conversations with staff; being a recipient of new messages |

With at least one section a guardian also sees the player's **name and batch**. Birth date, e-mail, phone, notes,
preferences and the adult's account id are never included.

A shared invoice (several players) is visible only if `FEES` is held for **every** invoiced player.

## Lifecycle

1. **Adulthood recorded.** Staff save the player with `adult: true` (`players/save`). In the same transaction one
   `ACCESS_ENDED_ADULTHOOD` event is written per active guardian link. From the guardian's next request the player is
   gone from their portal and every direct route answers 404.
2. **Adult account.** Staff create an `ADULT_PLAYER` account and set it as the player's own account (existing flow).
3. **Grant.** The adult calls `POST /api/academy/guardian-access/save`. First grant: `GRANTED`.
4. **Change / revoke.** Same request with a different list (`SCOPES_CHANGED`) or an empty list (`REVOKED`). Effective on
   the guardian's next request.
5. **Automatic ends** (never grants): the guardian's link is deactivated (`ENDED_LINK_INACTIVE`; re-activating the link
   restores nothing), or the adult flag is cleared (`ENDED_ADULT_FLAG_CLEARED`; the guardians of a minor have ordinary
   access again, and a later adulthood starts from nothing).

## API

| Request | Who | Result |
| --- | --- | --- |
| `GET /api/academy/guardian-access` | adult player | own record: every linked guardian, what each holds, grant version, history |
| | guardian | only the sections they themselves hold, per adult player |
| | anyone else | 403 |
| `POST /api/academy/guardian-access/save` `{playerId, guardianUserId, scopes: [...], version}` | adult player only | sets exactly these sections; `[]` revokes; `version` is the grant version last seen (0 if none) |

Refusals: not a player account 403; not the caller's own adult record, or a guardian without an active link to it /
without an active guardian membership / the caller themself 404; unknown or repeated section name (including
`CONSENT`) 422; stale `version` 409 `GUARDIAN_ACCESS_CONFLICT`. The academy, the actor and the role are always taken
from the session, never from the request.

## Where it is enforced (server side)

* `academy/application/access.ts`: `familyScope` re-reads link, profile and grant from the database on **every**
  request (nothing is cached) and derives the sections per player. `requirePlayer(actor, id, tx, section)` and
  `accessiblePlayers(..., section)` are the gates. **Leaving the section out demands full authority**, which a guardian
  reading through a grant never has, so code that was not written with grants in mind (consent, future routes) denies
  by default.
* `academy/application/bootstrap-family.ts`: every child-keyed query of the Family Portal is keyed, in SQL and again in
  JavaScript, by the children for which that section is held.
* Direct routes: report PDF (`REPORTS`), receipt PDF and payment (`FEES`), media link and file (`MEDIA`), restrictions
  and questions (`HEALTH`), conversations (`MESSAGES`).
* Staff-initiated paths that would hand data to a guardian: message recipients are recomputed at preview, approval and
  send and include a guardian of an adult only with `MESSAGES`; a conversation with such a guardian needs `MESSAGES`;
  an invoice addressed to such a guardian needs `FEES`.
* A grant counts only if **all** hold: not revoked; guardian link active; profile is an adult profile naming an own
  account; the grant was made by exactly that account; scopes are a well-formed list of known names. Anything else
  (malformed scopes, a grant made by another account, a profile that later names a different account, a non-boolean
  adult flag) gives nothing.
* Writes run inside the academy lock and after `lockActor` (RC-2), so concurrent grant/revoke requests are serialised
  and a stale one gets 409.

## Data (migration `0014_adult_guardian_access`)

* `guardian_access_grant`: current state, one row per (academy, player, guardian), foreign key to the guardian link.
* `guardian_access_event`: append-only history (UPDATE, DELETE and TRUNCATE refused by triggers): event, scopes, actor,
  actor role, time.
* Additive. **No grant is created by the migration**: guardians of players who are already adults lose access to those
  players when this release is deployed (owner decision; notice periods: 14 days academy, 7 days families).
* Rollback: `migrations-rollback/0014_adult_guardian_access.down.sql` (guarded; destroys grants and history; the older
  application then lets guardians read adult players again).

Pre-deployment census (read-only):

```sql
-- adult players whose guardians will lose access at deployment
select p.academy_id, count(distinct p.player_id) as adult_players_with_active_guardian_links
  from player_profile p
  join guardian_link l on l.academy_id = p.academy_id and l.player_id = p.player_id and l.active
  join membership m on m.academy_id = l.academy_id and m.user_id = l.user_id and m.role = 'GUARDIAN'
 where p.data->>'adult' = 'true'
 group by 1;
-- profiles that will be treated as adult-controlled because the flag is not a clean boolean false (should be 0)
select count(*) from player_profile
 where jsonb_typeof(data->'adult') is distinct from 'boolean'
    or (data->>'adult' = 'false' and coalesce(data->>'selfUserId', '') <> '');
```

## Limitations and open decisions

* **No screen for the adult yet.** The API is complete; the "Access & Preferences" screen is RC-5 in the approved
  sequence. Until then an adult can only grant through the API.
* **No expiry.** A grant lasts until the adult changes or revokes it, or it ends automatically (above).
* **Existing adults are not logged at deployment.** `ACCESS_ENDED_ADULTHOOD` is written when adulthood is recorded
  after this release; for players already adult the census above is the record.
* **Changing a player's own account** makes earlier grants void (they were made by the previous account) without an
  event; the new account grants again.
* **A deactivated adult account** leaves its grants in force. Whether they should end is a product decision.
* **Messages about several children** (a minor and an adult without `MESSAGES`): the guardian still receives the
  message for the minor; the adult's id is removed from it, the text is whatever staff wrote.
* `HEALTH` lets a guardian update the adult's allergies and restrictions, as the approved scope table lists it.
* Granting and viewing grants are not written to the sensitive-data access log (its categories are fixed by a
  database constraint); the grant history is the audit record.
