-- Manual rollback for migrations/0014_adult_guardian_access.sql. It is NOT applied by `db:migrate`.
--
-- Revert the application code FIRST: code that carries RC-4 reads these tables on every family request.
-- Take a backup first (stopped-instance checkpoint). The rollback DESTROYS every guardian access grant and the whole
-- grant history: both tables are dropped. Nothing else is touched: guardian_link, consent history, player profiles
-- and all other data stay.
-- NOTE: the pre-RC-4 application lets every linked guardian read an adult player's record again. Rolling back
-- therefore RESTORES the guardian access that RC-4 ended. Decide that deliberately.
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping (the project's guarded rollback
-- convention, as for 0012 and 0013), and starts with a guard that refuses (raising an error, so nothing at all is
-- changed) unless:
--   * 0014 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794381959210 (0014's
--     journal "when") exists, carries the hash of the reviewed 0014 file (LF or CRLF checkout), and is the only
--     row with that timestamp;
--   * 0014 is the LATEST applied migration (no row with a later created_at);
--   * every object 0014 created still exists (both tables, the function and both triggers).
-- Only 0014's own bookkeeping row is deleted, by its exact timestamp, never "the newest row". If the script stops
-- with an error, the transaction is aborted: end the session (or run ROLLBACK) and nothing has changed.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0014 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794381959210
     AND hash IN ('768fde6ffee6c7cc039718a9f06338b1d15d1c3570b2a0a7e8e58d2db69de5a9',
                  'cf821bff678dfdddd584a99b3b9bf47dc6f3963eb99432c3b90c68f5e6bb9a4b');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794381959210) <> 1 THEN
    RAISE EXCEPTION '0014 rollback refused: migration 0014_adult_guardian_access is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794381959210;
  IF newer > 0 THEN
    RAISE EXCEPTION '0014 rollback refused: % later migration(s) are applied after 0014; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'table guardian_access_grant' o WHERE to_regclass('public.guardian_access_grant') IS NULL
    UNION ALL SELECT 'table guardian_access_event' WHERE to_regclass('public.guardian_access_event') IS NULL
    UNION ALL SELECT 'function guardian_access_event_no_change' WHERE NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'guardian_access_event_no_change')
    UNION ALL SELECT 'trigger guardian_access_event_immutable' WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guardian_access_event_immutable')
    UNION ALL SELECT 'trigger guardian_access_event_no_trunc' WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'guardian_access_event_no_trunc')
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0014 rollback refused: the schema does not match migration 0014 (missing: %). Nothing was changed', missing;
  END IF;
END $$;
DROP TRIGGER guardian_access_event_no_trunc ON "guardian_access_event";
DROP TRIGGER guardian_access_event_immutable ON "guardian_access_event";
DROP TABLE "guardian_access_event";
DROP FUNCTION guardian_access_event_no_change();
DROP TABLE "guardian_access_grant";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794381959210;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0014 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
