-- Manual rollback for migrations/0007_consent_management.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. THIS DISCARDS THE ENTIRE CONSENT HISTORY (every recorded decision, with its actor,
-- method, evidence and document version) and every consent policy version. Do not run it on a database
-- whose history you may need as evidence. What survives: guardian_link.consent, the current flags that
-- gate messaging, which always carried the latest state. Roll the Phase 5 application code back with it.
-- Afterwards remove drizzle's bookkeeping row so a later `db:migrate` re-applies 0007 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DROP TRIGGER consent_event_no_change ON "consent_event";
DROP TRIGGER consent_policy_version_frozen ON "consent_policy_version";
DROP TABLE "consent_event";
DROP TABLE "consent_policy_version";
DROP FUNCTION consent_event_append_only();
DROP FUNCTION consent_policy_version_guard();
COMMIT;
