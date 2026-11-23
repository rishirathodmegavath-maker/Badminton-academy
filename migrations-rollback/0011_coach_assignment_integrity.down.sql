-- Manual rollback for migrations/0011_coach_assignment_integrity.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. 0011 added only two triggers and their functions (no column, constraint or
-- row), so the rollback removes exactly those and touches no data. Batch, session and event
-- reassignments the application made while 0011 was in place are ordinary data and stay as they are.
-- Afterwards remove drizzle's bookkeeping row so a later `db:migrate` re-applies 0011 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DROP TRIGGER membership_coach_assignments ON "membership";
DROP TRIGGER batch_coach_must_coach ON "batch";
DROP FUNCTION membership_coach_assignments();
DROP FUNCTION batch_coach_must_coach();
COMMIT;
