-- Manual rollback for migrations/0009_privacy_lifecycle.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. It DESTROYS every retention rule, legal hold, erasure request, erasure history and
-- pending file-deletion record (the five new tables are dropped). It never touches application data, consent
-- history or the access history. If any erasure was COMPLETED, keep the erasure ledger file: it is what
-- protects against restoring erased data (see PRIVACY_LIFECYCLE.md). The access history's category list is put
-- back to its Phase 7 value; if privacy-related access events exist (category PRIVACY) the rollback stops
-- here, because the append-only history must not be rewritten.
-- Afterwards remove drizzle's bookkeeping row so a later `db:migrate` re-applies 0009 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "access_event" WHERE "category" = 'PRIVACY') THEN
    RAISE EXCEPTION 'access_event contains PRIVACY events; rolling back 0009 would require rewriting the append-only access history';
  END IF;
END $$;
ALTER TABLE "access_event" DROP CONSTRAINT "access_event_category_check";
ALTER TABLE "access_event" ADD CONSTRAINT "access_event_category_check" CHECK ("access_event"."category" in ('WORKSPACE', 'CONSENT', 'REPORT', 'NUTRITION', 'MEDIA', 'FINANCE', 'ACCOUNT_SECURITY', 'AUDIT_LOG', 'TRAINING'));
DROP TRIGGER erasure_event_no_truncate ON "erasure_event";
DROP TRIGGER erasure_event_no_change ON "erasure_event";
DROP TABLE "storage_deletion";
DROP TABLE "erasure_event";
DROP TABLE "erasure_request";
DROP TABLE "legal_hold";
DROP TABLE "retention_policy";
DROP FUNCTION erasure_event_append_only();
COMMIT;
