-- Manual rollback for migrations/0006_mfa_policy.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. It discards every academy's stored two-factor policy (mode, roles, warn start).
-- Afterwards each academy is governed only by the deployment setting (MFA_ENFORCEMENT /
-- MFA_REQUIRED_ROLES), i.e. "off" unless that is set. Roll the Phase 4 application code back with
-- this script: older code does not know the table, but nothing else depends on it.
-- Nothing else is touched. Afterwards remove drizzle's bookkeeping row so a later `db:migrate`
-- re-applies 0006 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DROP TABLE "academy_mfa_policy";
COMMIT;
