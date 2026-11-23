-- Manual rollback for migrations/0008_access_audit.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. It DESTROYS the whole sensitive-data access history (the table is dropped); use it only
-- before that history matters, or after exporting it. Nothing else is touched: audit_event, security_event,
-- consent history and all application data stay. Older application code does not know the table.
-- Afterwards remove drizzle's bookkeeping row so a later `db:migrate` re-applies 0008 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DROP TRIGGER access_event_no_truncate ON "access_event";
DROP TRIGGER access_event_no_change ON "access_event";
DROP TABLE "access_event";
DROP FUNCTION access_event_append_only();
COMMIT;
