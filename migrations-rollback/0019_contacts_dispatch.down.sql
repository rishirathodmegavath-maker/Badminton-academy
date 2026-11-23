-- Manual rollback for migrations/0019_contacts_dispatch.sql. It is NOT applied by `db:migrate`.
--
-- Revert the application code FIRST: code that carries this change reads and writes contact_point, report_policy,
-- dispatch_batch, dispatch_item, dispatch_event and report_link, and reads observation_review.category.
-- Take a backup first (stopped-instance checkpoint). The rollback DESTROYS those five tables (WhatsApp opt-in records,
-- delivery history and report links) and the column observation_review.category (the category tags coaches gave to
-- reviewed observations). Reports, players, accounts, memberships and sessions are NOT touched. Because that history is
-- real data, the script REFUSES while any row exists in those tables, or any category tag exists, unless the same session
-- first runs:   SET sportozen.rollback_dispatch = 'destroy';
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping (the project's guarded rollback
-- convention, as for 0012 to 0018), and starts with a guard that refuses (raising an error, so nothing at all is
-- changed) unless:
--   * 0019 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794600000000 (0019's journal
--     "when") exists, carries the hash of the reviewed 0019 file (LF or CRLF checkout), and is the only row with
--     that timestamp;
--   * 0019 is the LATEST applied migration (no row with a later created_at);
--   * every object 0019 created still exists;
--   * no data would be destroyed, or the destroy confirmation above was given.
-- Only 0019's own bookkeeping row is deleted, by its exact timestamp, never "the newest row". If the script stops
-- with an error, the transaction is aborted: end the session (or run ROLLBACK) and nothing has changed.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
  rows_at_risk bigint;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0019 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794600000000
     AND hash IN ('d4dc307926a3708ca052c3b89ad448b2ec2e1b6c69ef0ed7cf5af47c6a115bb8',
                  'df6ce0fc6bac05f1c18e39972831597765cc9898df14b1cbf1aee47000bcb72b');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794600000000) <> 1 THEN
    RAISE EXCEPTION '0019 rollback refused: migration 0019_contacts_dispatch is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794600000000;
  IF newer > 0 THEN
    RAISE EXCEPTION '0019 rollback refused: % later migration(s) are applied after 0019; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'table contact_point' o WHERE to_regclass('public.contact_point') IS NULL
    UNION ALL SELECT 'table report_policy' WHERE to_regclass('public.report_policy') IS NULL
    UNION ALL SELECT 'table dispatch_batch' WHERE to_regclass('public.dispatch_batch') IS NULL
    UNION ALL SELECT 'table dispatch_item' WHERE to_regclass('public.dispatch_item') IS NULL
    UNION ALL SELECT 'table dispatch_event' WHERE to_regclass('public.dispatch_event') IS NULL
    UNION ALL SELECT 'table report_link' WHERE to_regclass('public.report_link') IS NULL
    UNION ALL SELECT 'column observation_review.category' WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'observation_review' AND column_name = 'category')
    UNION ALL SELECT 'constraint observation_review_category' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observation_review_category')
    UNION ALL SELECT 'index dispatch_item_one_per_address' WHERE to_regclass('public.dispatch_item_one_per_address') IS NULL
    UNION ALL SELECT 'index contact_point_subject_address' WHERE to_regclass('public.contact_point_subject_address') IS NULL
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0019 rollback refused: the schema does not match migration 0019 (missing: %). Nothing was changed', missing;
  END IF;
  SELECT (SELECT count(*) FROM contact_point) + (SELECT count(*) FROM report_policy) + (SELECT count(*) FROM dispatch_batch)
       + (SELECT count(*) FROM dispatch_item) + (SELECT count(*) FROM dispatch_event) + (SELECT count(*) FROM report_link)
       + (SELECT count(*) FROM observation_review WHERE category IS NOT NULL) INTO rows_at_risk;
  IF rows_at_risk > 0 AND coalesce(current_setting('sportozen.rollback_dispatch', true), '') <> 'destroy' THEN
    RAISE EXCEPTION '0019 rollback refused: % row(s) of contacts, policy, delivery history, links or category tags would be destroyed. Back them up, then run SET sportozen.rollback_dispatch = ''destroy''; in the same session and repeat. Nothing was changed', rows_at_risk;
  END IF;
END $$;
DROP TABLE "report_link";
DROP TABLE "dispatch_event";
DROP TABLE "dispatch_item";
DROP TABLE "dispatch_batch";
DROP TABLE "report_policy";
DROP TABLE "contact_point";
ALTER TABLE "observation_review" DROP CONSTRAINT "observation_review_category";
ALTER TABLE "observation_review" DROP COLUMN "category";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794600000000;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0019 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
