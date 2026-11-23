# Migration 0018 (academy invitations) — execution runbook for the local development database

**Status: prepared, NOT executed.** Nothing in this runbook has been run against `.data/development`. The procedure was
**rehearsed on a throwaway copy** of that database (Section 7). Applying 0018 to the real development database, creating the
backup, and restarting the server each need your explicit go-ahead; this document is what you approve.

## 1. What 0018 is
* One new table `academy_invitation` (21 constraints, 5 indexes) and two triggers (`academy_invitation_guard`: no delete, terminal
  states final, identity columns immutable; `academy_invitation_no_truncate`). Additive: no existing table, column, row or
  constraint is changed.
* Journal tag `0018_academy_invitations`, `when` 1794513818712. It follows 0017 (the development database is at 0017: 18 migrations applied).
* Guarded rollback: `migrations-rollback/0018_academy_invitations.down.sql` (hash-pinned; refuses unless 0018 is the **latest** applied
  migration and intact; refuses while any invitation exists unless the same session first runs `SET sportozen.rollback_invitations = 'destroy';`;
  runs as one transaction, bookkeeping included). It is never run by `db:migrate`.
* The application code in the working tree already needs the table: until 0018 is applied, the invitation endpoints, the Settings →
  Invitations tab and `/invite` answer with an error on the development server (all other screens are unaffected).

## 2. Where the development database is
| | |
|---|---|
| Setting | `LOCAL_DATABASE_PATH=./.data/development` in `.env.local` (not modified, only read for this key) |
| Resolved folder | `D:\Audit\badmintonsoftware\.data\development` (embedded PostgreSQL 18 data directory, `PG_VERSION` = 18) |
| Size when inspected | 1,272 files, 59,941,059 bytes (about 57 MB) |
| In use by | the development server on port 3100 (node PID 15868, started 2026-11-13 00:32, `next/dist/server/lib/start-server.js`). It keeps a `postmaster.pid` in the folder while it runs. |
| Proposed backup | `D:\Audit\Phase1\dev-db-backup-before-0018` — **does not exist today**, so nothing would be overwritten. Manifest next to it: `dev-db-backup-before-0018.sha256.txt`. |
| Earlier backups (same convention) | `…\dev-db-backup-before-0017` (+ `.sha256.txt`, 1,266 lines), `…before-0016`, `…before-0013` and older |

An embedded database is **single-process**: the folder must not be copied or migrated while the server runs. That is why step 1 stops it.

## 3. Prerequisites (check, do not skip)
1. You have approved: stopping the server on 3100, the backup, and `db:migrate` against `.data/development`.
2. `git status` shows the working tree you expect (the migration files `migrations/0018_academy_invitations.sql`,
   `migrations/meta/0018_snapshot.json`, `migrations/meta/_journal.json` and the rollback script are present).
3. `D:\Audit\Phase1\dev-db-backup-before-0018` and `….sha256.txt` do not exist (the script refuses to overwrite).
4. Free disk space on `D:` of at least 200 MB.
5. The last full test run was green (see `OVERNIGHT_REGRESSION_REPORT.md`).

## 4. Execution (PowerShell, from `D:\Audit\badmintonsoftware`)

**Step 1 — stop the server you started (only if you approve).** Identify it first; do not stop anyone else's process:
```powershell
Get-NetTCPConnection -LocalPort 3100 -State Listen | ForEach-Object { Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" } | Select ProcessId, CreationDate, CommandLine
Stop-Process -Id <that PID>          # a clean stop removes postmaster.pid
Test-Path .\.data\development\postmaster.pid      # must now be False
```

**Step 2 — backup with SHA-256 evidence** (`scripts/backup-dev-db.ps1`; it refuses while `postmaster.pid` exists, refuses to overwrite, copies,
writes the manifest, then re-reads the copy and compares every hash):
```powershell
powershell -NoProfile -File .\scripts\backup-dev-db.ps1
# expected last lines:  "<N> files verified against ...\dev-db-backup-before-0018.sha256.txt"  /  "Backup complete"  /  the manifest's own SHA-256 (write it down)
powershell -NoProfile -File .\scripts\backup-dev-db.ps1 -Mode Verify      # independent second check
```

**Step 3 — plan, then apply** (`db:migrate` loads `.env.local`; the plan only reports, the second command applies):
```powershell
npm run db:migrate:plan      # expect: "Already applied: 18" / "Would apply: 0018_academy_invitations"
npm run db:migrate           # expect: "Applied: 0018_academy_invitations"  (took ~14 s on the rehearsal copy, including start-up)
npm run db:migrate:plan      # expect: "Already applied: 19" / "Database is up to date."
```

**Step 4 — verify the database** (`scripts/dev-db-tool.ts`, read-only; it refuses while a server holds the folder; the server is still stopped):
```powershell
npx tsx scripts/dev-db-tool.ts state .\.data\development
# expect: {"migrations_recorded":19}  {"academy_invitation":"academy_invitation"}  {"invitations":0,"triggers":2}
```

**Step 5 — start the application and verify behaviour** (development server on 3100 as before: `npm run dev`):
1. `GET /api/auth/account/sign-in-methods` answers 200.
2. Sign in as a seeded Owner (`admin@greenfield.example`, password from your `DEV_SEED_PASSWORD`); the workspace loads.
3. **Settings → Invitations** shows "No invitations to show." (this is the screen that errored before the migration).
4. Create an invitation for a throw-away address (a `@example.test` address, role COACH): a one-time link is shown. Open it in a private window:
   the review page names the academy and masked address. **Withdraw** the invitation (the link then answers "withdrawn"). Do not accept it with a real account.
5. Settings → Staff & family access, Players, Calendar and Fees still open (nothing else changed).
6. `Switch academy` still lists the academies of a multi-academy account (e.g. `/academies`).

**Step 6 — record the result** (command output, the manifest SHA-256, the test invitation's withdrawal) in your release notes.

## 5. If something goes wrong (decision table)
| Symptom | Meaning | Action |
|---|---|---|
| Backup script refuses ("postmaster.pid exists") | the server may still be running | stop it (Step 1). After a crash with nothing running, repeat with `-AllowStalePid`. |
| Backup script refuses ("Refusing to overwrite") | the destination exists | do **not** delete it; choose a new destination (`-Destination`) and tell me. |
| `VERIFICATION FAILED` | the copy differs from the source | do not migrate. Retry the backup to a new folder; investigate disk problems. |
| `db:migrate` reports an error **before** applying | nothing changed (statements run in a transaction per migration) | read the message, fix the cause, re-run the plan. |
| `db:migrate` fails or is interrupted **during** 0018 | the migration is transactional: it either applied or it did not | run `npm run db:migrate:plan`. "Would apply: 0018…" means nothing changed — retry. "Up to date" means it completed. |
| Plan says 0018 applied but verification fails (table missing, wrong trigger count) | inconsistent state; very unlikely | stop; **restore** (below). |
| The application misbehaves after a successful migration | an application problem, not a data problem | the table is additive: leave it and revert the code, or run the guarded rollback (below). Data is unharmed. |

**Option A — guarded rollback** (undoes 0018 only; safe while no invitation exists; the server must be stopped):
```powershell
npx tsx scripts/dev-db-tool.ts run-sql .\.data\development .\migrations-rollback\0018_academy_invitations.down.sql          # dry run: says what it would do
npx tsx scripts/dev-db-tool.ts run-sql .\.data\development .\migrations-rollback\0018_academy_invitations.down.sql --yes
npx tsx scripts/dev-db-tool.ts state .\.data\development      # expect {"migrations_recorded":18} {"academy_invitation":null}
```
If invitations exist the script refuses with a clear message and changes nothing (add `SET sportozen.rollback_invitations = 'destroy';` only if you accept losing them).

**Option B — full restore from the backup** (the live folder is moved aside, never deleted; the backup is verified first):
```powershell
powershell -NoProfile -File .\scripts\backup-dev-db.ps1 -Mode Restore -ConfirmRestore
# prints "N files verified" twice (backup before, restored folder after) and where the replaced folder was kept
```
Never delete the backup or the folder that was moved aside until you have verified the application and recorded the result.

## 6. Verifying the application after migration (checklist)
`npm run typecheck`; `npm test` (PGlite, includes `migrations-0018.test.ts`); `npm run test:pg` with `TEST_POSTGRES_IMAGE=postgres:17-alpine` and `postgres:18-alpine`
for the migration suites; Playwright `invitations.spec.ts` against a **disposable** server (never against 3100's data). The last results are in `OVERNIGHT_REGRESSION_REPORT.md`.

## 7. Rehearsal evidence (on a copy; the development database was not opened or changed)
| Check | Result |
|---|---|
| Copy of `.data/development` into the scratchpad (read-only on the source) | 1,272 files, 59,941,059 bytes, identical count and size |
| `db:migrate:plan` on the copy | `Already applied: 18` / `Would apply: 0018_academy_invitations` |
| `db:migrate` on the copy | `Applied: 0018_academy_invitations`, 13.6 s wall time |
| Row counts of all 60 tables, copy before vs after | **identical except** the new `academy_invitation` (0 rows); migration rows 18 → 19 |
| Objects created | 2 triggers, 5 indexes, 21 constraints on `academy_invitation` |
| Guarded rollback on the migrated copy | table removed (`to_regclass` null), migrations back to 18, no other change |
| Re-apply after rollback; second `db:migrate` | `Applied: 0018…`; then `Already applied: 19` / `Database is up to date.` (idempotent) |
| `scripts/dev-db-tool.ts` on the copy | `state` before/after, dry run changes nothing, `--yes` rollback then `state` shows 18 / no table, re-apply gives 19 with 2 triggers; refuses a folder with `postmaster.pid` and a folder that is not a data directory |
| `scripts/backup-dev-db.ps1` on scratch copies | refuses a live-looking folder (fabricated `postmaster.pid`), refuses a folder that is not a data directory, refuses to overwrite, backs up and verifies 1,271 files, detects a one-byte change, refuses to restore a tampered backup and a restore without `-ConfirmRestore`, restores a good backup and keeps the replaced folder |

Limits of the rehearsal: it ran with the server still running (the copy was taken from a live folder, which is acceptable only for a
rehearsal); the real procedure stops the server first. The rehearsal used PGlite (the development engine); the same migration is also
verified on PostgreSQL 17 and 18 by `tests/migrations-0018.test.ts` and `tests/migrations.test.ts`.
