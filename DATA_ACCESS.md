# Role-based data access (Phase 2.3)

Who may see or change which data, enforced on the server and deny-by-default. This closes
PHASE1_FINDINGS P1-01 (Finance and Nutrition Pro over-exposure). Nothing here depends on the UI.

## Where the decisions are made

| Concern | One place |
| --- | --- |
| Which players an actor may see or act on | `accessiblePlayers()` / `requirePlayer()` in `src/modules/academy/application/access.ts` |
| Which players Finance may put on an invoice or credit | `billablePlayers()` / `requireBillablePlayer()` (same file) |
| What each role receives in the whole-academy read model | `bootstrapAcademy()` (`bootstrap.ts`), with explicit projections for the two narrow roles |
| Who may sign in and be treated as which role | `resolveActor()` (`identity/access.ts`): exactly one *active* membership, a *known* role |

`accessiblePlayers()` is a `switch` on the role with no "everyone else" fallthrough: **a role it does not
name, and FINANCE, get no players**. Every service that names a player (`reports`, `media`, `nutrition`,
`players`, `communications`, `calendar`, receipts) goes through `requirePlayer`, so a request cannot gain
access to a player merely by naming its id. All data is also filtered by `academy_id`, so tenants stay apart.

## Policy by role (decisions taken, with the reason)

| Role | Players | Read model | Notes |
| --- | --- | --- | --- |
| OWNER, ADMIN | all in the academy | everything except family-restricted nutrition questions/allergies (unchanged) | ADMIN additionally may assign Nutrition Pros (see below); no other permission changed |
| HEAD_COACH | all in the academy | unchanged | |
| COACH | players in batches they coach | unchanged | |
| **FINANCE** | **none** (billing roster only) | invoices, payments, refunds, lesson credits, fee plans; each player as **id + name + batch + status flag**; billing contacts named on invoices by name only | the six former `todo` rules: no profile data, no clinical/operational records, no member e-mails, no consent links, no nutrition |
| **NUTRITION_PRO** | **only players with an active assignment** | those players (same bare projection), their nutrition plans/restrictions/questions and nutrition-plan revisions; their own member record and assignments | no profile data, reports, media, history, events, finance, consent links, other accounts |
| GUARDIAN | players with an active guardian link | unchanged (family-safe projection) | |
| ADULT_PLAYER | own record | unchanged | |
| anything else / no or inactive membership | none; request refused | none | |

Decisions that were ambiguous and how they were settled:

* **Finance keeps invoicing every player of its academy.** An invoice has to name a player, so Finance gets the
  *billing roster* (name, batch, active flag) and nothing else. It is deliberately separate from player access so
  it cannot leak into reports, media, or nutrition paths.
* **Nutrition Pro: assigned players only; no implicit access.** There was no existing relationship, so a minimal
  table `nutrition_assignment` was added (migration `0005`). An unassigned professional sees nothing, which also
  means **after deploying, every existing Nutrition Pro sees no players until an owner/admin assigns them**
  (Settings -> Roles & permissions -> *Assign players*, or `POST /api/academy/nutrition/assign`). No backfill was done:
  granting everyone everything would reproduce the exposure being removed.
* **Who assigns:** OWNER and ADMIN only (they already manage every player). This is the single new permission, needed to
  operate the model; no existing permission was changed. HEAD_COACH cannot assign.
* **Nutrition Pro can read questions asked by families about their assigned players** (that is their job); they cannot
  see anything else about those players or their families.
* Withdrawing an assignment (or deactivating/demoting the professional) removes access on the next request.

## API surface and direct-ID paths

| Path | FINANCE | NUTRITION_PRO (assigned / not) |
| --- | --- | --- |
| `GET /api/academy` | projection above | projection above |
| `GET reports/:id/pdf`, `media/:id/link\|file`, report/media/profile writes | refused (404/403) | refused (403 even if assigned; 404 if not) |
| `GET fees/:id/receipt`, fee writes | allowed | refused (403) |
| `POST nutrition/plan\|restrictions\|question` | refused | allowed for assigned; 404 otherwise |
| `POST nutrition/assign` | refused | refused (OWNER/ADMIN only) |
| `POST fees/invoice\|credit` | allowed for any player of the same academy | refused |

`tests/data-access.test.ts` exercises each of these (positive control + refusal + "database unchanged").

## Response projections

Narrow roles never receive full rows with fields removed afterwards; `bootstrapAcademy` builds their output
from an allow-list: a player is `{id, academyId, name, batchId, version: 1, profile: <empty profile + status>}`,
`guardianLinks`/`events`/`history`/`reports`/`media`/`sessions`/... are not queried for them, members are
filtered to themselves (and, for Finance, billing contacts with the e-mail blanked), and batches have the coach id
blanked. Tests walk the whole JSON for e-mail addresses, profile canaries and secret-looking keys.

## Schema

`nutrition_assignment(academy_id, player_id, professional_id, active, assigned_by, created_at, updated_at)`;
primary key (academy, player, professional); composite foreign keys to `player(academy_id,id)` and
`membership(academy_id,user_id)` so an assignment cannot cross academies; index (academy, professional, active).
Additive. Rollback: `migrations-rollback/0005_nutrition_assignment.down.sql` (discards assignments; with the
Phase 2.3 code still deployed no Nutrition Pro could see any player).

## Known limitations / out of scope

* The `audits` list (owner/admin/head coach) and any history UI are unchanged; consent history (Phase 5), withdrawal (6),
  sensitive-access logging (7) and erasure (8) are not started.
* Assignment changes are recorded in the existing academy audit (`nutrition-assigned` / `nutrition-unassigned`); they are
  not yet shown with the professional's name in the UI.
* HEAD_COACH and COACH can still author nutrition *drafts* for players they can access (existing behaviour); only a
  Nutrition Pro approves and, with owner/admin/head coach, shares them.
* Other roles' projections were reviewed, not re-cut: they keep their existing, test-pinned behaviour.
