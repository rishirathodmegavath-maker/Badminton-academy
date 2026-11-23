# Adult-player data investigation (read-only)

Date: 2026-11-21. Question: does any real database hold adult-player records, so that the three adult-player test suites
(`adult-guardian-access`, `rc5-guardian-access-http`, `rc5-message-withholding`) could be retired safely?
Nothing was modified: no application code, database record, migration, test, browser spec or server. Both running servers were left
alone (3300 answered 200 afterwards). The report contains counts only: no name, e-mail, phone, birth date or identifier.

## Answer in one paragraph

**No real adult-player record exists in any database that could be checked.** The database behind the running Badminton server holds
2 players, both under 18, and no adult flag, no adult login, no adult invitation and no access grant. The only adult records found are
**2 fictional seed fixtures** in the original project's development database (one per fictional academy, exactly the shape the
development seed script plants). **Staging and production could not be checked** (none is reachable from this machine and no
authorized read-only access exists), so "none anywhere" cannot be proven from here; a read-only check for you to run there is given below.
**Recommendation: RETIRE the obsolete tests** (details and conditions at the end).

## 1. What "adult player" means in this code (not guessed)

Sources: `src/modules/players/domain/age.ts`, `players/application/age-rules.ts`, `players/application/age-review.ts`,
`players/application/service.ts`, `academy/application/access.ts` (`adultControlled`), `academy/domain/guardian-access.ts`.

| Rule | Where | Meaning |
| --- | --- | --- |
| `PLAYER_MAX_AGE = 18`; `isUnder18(birth, today) = ageOn(birth, today) < 18`; a player is 18 on the day of the 18th birthday (29 Feb turns 18 on 1 Mar in a common year); "today" is the academy's own calendar day in its time zone | `age.ts` | the age test; I ran the project's own `ageOn/isUnder18/ageState` functions on the copied data, not a re-implementation |
| `requireUnder18`: refuses `profile.adult` or `profile.selfUserId` (422 `ADULT_PLAYERS_NOT_SUPPORTED`), requires a valid birth date, refuses 18+ except for an archived player or one the owner "kept for now" until a recheck day | `age-rules.ts` | what the app accepts since 18 Nov |
| `savePlayer` stores `adult:false, selfUserId:null` whatever is sent | `players/application/service.ts` | no path can create or keep an adult profile |
| `ageState`: `ARCHIVED` = out of the picture; no valid birth date = `BIRTH_DATE_MISSING`; 18+ = `DECIDE` (owner decision needed) or `KEPT` (owner chose to keep, until a day) | `age.ts` | statuses I counted by |
| **Adult-controlled record** = `profile.adult !== false` **or** a non-empty `profile.selfUserId` | `academy/domain/guardian-access.ts` `adultControlled` | the records the three suites protect; a guardian reads them only through a grant the adult made |
| Stored profile statuses: `ACTIVE`, `PAUSED`, `ARCHIVED`. Erased players keep a row named "Erased player" (privacy erasure); there is no soft-delete flag | `ProfileData`, `privacy` | statuses/deleted handling used below |

So "adult-player records" were counted in five independent ways: (a) adult flag, (b) own-account link, (c) `ADULT_PLAYER` role memberships and
invitations, (d) 18 or older by the code's age rule (split into needs-decision, kept-by-owner, archived), and (e) players whose age cannot be
established (no valid birth date).

## 2. Environments

| Environment | Found? | Checked? |
| --- | --- | --- |
| **Local development database behind the running Badminton server (port 3300)** — `badminton-main-local\data\pglite` | yes | **yes** |
| Its backup taken before migration 0019 — `...\pglite-backup-before-0019` | yes | **yes** |
| **Original Badminton project's development database** — `D:\Audit\badmintonsoftware\.data\development` (the project this one was copied from) | yes | **yes** |
| Disposable test databases (`.data\<name>-<12 hex>` in this project and the original) | yes (leftovers of earlier test runs) | no: they are created by tests, and the adult suites deliberately fill them with adult fixtures, so they say nothing about real data |
| Staging | no configuration, URL or credential on this machine | **not checked** |
| Production | none known; `PRODUCTION_READINESS_REPORT.md` states nothing was deployed; no `DATABASE_URL` is set in this shell or in this project (only `.env.example`) | **not checked** |
| The original project's `.env.local` | exists | **deliberately not opened** (it holds secrets; the brief forbids reading them). It was not needed: the local databases above are embedded files, and no authorized read-only remote access exists |
| Football | a different application with its own SQLite database | out of scope for this Badminton question; not checked |

## 3. Evidence that the check was read-only

1. **The original data directories were never opened by a database engine.** Each was copied (file reads only) to a temporary folder and
   the **copy** was queried; the copies were deleted afterwards. This also kept the live server's single-process database untouched.
2. **Fingerprints before and after** (file count, total bytes, SHA-256 over every file's content) of each original directory are
   **identical** (live 1,322 files / 61,153,475 bytes; backup 1,283 / 60,776,643; original-project 1,272 files). Runs were repeated;
   the live database's fingerprint was the same in every run, with the server running.
3. The query session was set `default_transaction_read_only = on` and `SHOW` returned `on` for all three.
4. Only `SELECT` statements were issued (the script refuses anything else). All 11 distinct statements are in
   `acceptance-evidence\investigation\adult-records-result.json`, together with the script `adult-records-readonly.mts`.
5. No migration, rollback, seed or application code ran. Servers were neither started, stopped nor restarted.

## 4. Counts (non-identifying)

| | Dev DB behind port 3300 | Its pre-0019 backup | Original project dev DB |
| --- | --- | --- | --- |
| Schema (migrations applied) | 20 | 19 | 18 |
| Academies / players / accounts | 1 / 2 / 2 | 1 / 2 / 2 | 2 / 20 / 17 |
| Accounts on the reserved `.example` domain (fictional) | 0 of 2 (real, user-made) | 0 of 2 | 16 of 17 (seed data) |
| Players under 18 by the code's rule | **2** | 2 | 0 |
| **Adult flag set** (active / paused / archived) | **0** / 0 / 0 | 0 / 0 / 0 | **2** / 0 / 0 |
| **Own-account link** (`selfUserId`) (active / paused / archived) | 0 / 0 / 0 | 0 / 0 / 0 | 2 / 0 / 0 |
| 18 or older by the age rule: needs decision / kept by owner / archived | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| No valid birth date (age cannot be established) | 0 | 0 | **20** (all players; seed data older than the birth-date requirement) |
| Erased players / erasure requests | 0 / 0 | 0 / 0 | 0 / 2 cancelled |
| `ADULT_PLAYER` memberships (active / inactive) | 0 / 0 | 0 / 0 | 2 / 0 |
| `ADULT_PLAYER` invitations | none | none | table not present (schema older than migration 0018) |
| Adult-flagged admission enquiries | none | none | none |
| Guardian links on adult-flagged players (active) | 0 | 0 | 2 (both of relationship "Adult self") |
| Guardian access grants (live / revoked) | 0 / 0 | 0 / 0 | 0 / 0 |
| Adult records that are NOT the seed fixture shape | 0 | 0 | **0** |

The two adult records in the original project's database are exactly the fixture the development seed (`scripts/seed-operations.ts`)
plants: one player per academy (`<academy>-intermediate-p1`) with the adult flag **and** an own-account link to a seeded `ADULT_PLAYER`
login, 16 of the 17 accounts there use the reserved `.example` domain, and no grant was ever made. They are test data, not real people.

## 5. Can existing adult records still be reached? (implications)

- **Creating or editing one is impossible through the application** (all four entry points refuse it; `savePlayer` rewrites the flag).
  Editing a stored adult profile with the flag still set is refused (422); saving it with the flag cleared **converts it to an ordinary
  minor profile and ends adult-controlled mode** (`ENDED_ADULT_FLAG_CLEARED`), after which every linked guardian again reads the whole record.
  That is harmless for fixtures, but it would be a privacy change for a real adult.
- **They can still be read.** An existing `ADULT_PLAYER` membership still signs in and sees its own record (nothing blocks the role; only
  assigning or inviting it is refused). Guardians of such a record see nothing unless a grant exists (the dormant RC-4 code, last changed
  12–13 Nov, still enforces this). The database still permits the role and the flag (migration constraints were not changed).
- **The development seed still plants an adult** (`seed-operations.ts`, and the e2e role fixtures `ADULT_PLAYER` used by
  `phase9-family.spec.ts` and `rc5-guardian-access.spec.ts`). Any database seeded with it holds one, as the original project's does.
  Retiring the tests without changing the seed would leave that fixture orphaned.
- **Players who turn 18** are not "adult-controlled": the age review archives them or keeps them with a reason; guardians keep ordinary access.
  None exist in any checked database.

## 6. Not checked, and why

- **Staging and production:** nothing is configured on this machine, no authorized read-only access is available, and I did not ask for or
  change any permission. I cannot state that none exist. Run this read-only statement there (it returns only a number):

  ```sql
  select (select count(*) from player_profile
            where (data->>'adult') = 'true' or coalesce(data->>'selfUserId','') <> '')            as adult_or_self_account_profiles,
         (select count(*) from membership where role = 'ADULT_PLAYER')                            as adult_player_memberships,
         (select count(*) from guardian_access_grant)                                             as access_grants;
  ```
  Zero in all three means the same conclusion holds there. (Players aged 18+ by birth date are a separate, already-handled age-review
  question, not adult-controlled records.)
- Disposable test databases and Football, for the reasons in section 2.
- The original project's `.env.local`, by design.

## 7. Recommendation: **RETIRE the obsolete tests**

Reasons: no real adult record exists in any database that could be examined; the only ones are fictional seed fixtures; the application
no longer lets an adult exist, so the suites cannot even build their fixtures; and the rewrite alternative would re-test a feature the owner
removed. The refusals that matter are already covered by tests that keep running (adult invitation in `invitations-http`; the adult login role in
`coach-assignment`; the age rule and age review in `player-age`; admissions in `operations`).

Conditions, for the retirement step (not performed):
1. Confirm the staging/production statement above returns zero where such environments exist.
2. Retire the three suites, the two adult browser specs (`rc5-guardian-access`, the adult case in `phase9-family`) and their entries in
   `scripts/with-disposable-postgres.ts` together, and change `seed-operations.ts` and the e2e role fixtures so the seed stops planting an
   adult, otherwise the seed contradicts the product.
3. **Keep the dormant adult guardian-access code** until staging/production are confirmed empty and you decide to remove it; it is the
   only thing protecting a real adult record should one ever turn up, and tests for it are the cost of keeping it. If you prefer to keep
   it with tests, the alternative is RETAIN AND REWRITE (seed legacy rows directly in isolated databases, update the consent-era wording),
   which this evidence does not justify.
