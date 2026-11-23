-- Manual rollback for migrations/0005_nutrition_assignment.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. It discards every Nutrition Pro assignment. With the table gone and the
-- Phase 2.3 application code still running, no Nutrition Pro could see any player (access is
-- deny-by-default), so roll the application code back together with this script.
-- Nothing else is touched. Afterwards remove drizzle's bookkeeping row so a later `db:migrate`
-- re-applies 0005 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DROP TABLE "nutrition_assignment";
COMMIT;
