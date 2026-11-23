-- Manual rollback for migrations/0016_guardian_phone.sql. It is NOT applied by `db:migrate`.
--
-- Revert the application code FIRST: code that carries this change reads app_user.phone when it sends WhatsApp messages.
-- Take a backup first (stopped-instance checkpoint). The rollback DESTROYS every registered phone number: the column
-- app_user.phone and its CHECK constraint are dropped. Nothing else is touched.
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping (the project's guarded rollback
-- convention, as for 0012 to 0014), and starts with a guard that refuses (raising an error, so nothing at all is
-- changed) unless:
--   * 0016 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794493950734 (0016's journal
--     "when") exists, carries the hash of the reviewed 0016 file (LF or CRLF checkout), and is the only row with
--     that timestamp;
--   * 0016 is the LATEST applied migration (no row with a later created_at);
--   * every object 0016 created still exists (the column and the constraint).
-- Only 0016's own bookkeeping row is deleted, by its exact timestamp, never "the newest row". If the script stops
-- with an error, the transaction is aborted: end the session (or run ROLLBACK) and nothing has changed.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0016 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794493950734
     AND hash IN ('7679d66d69a5720817b1f714e5b106d4abd37e4103888136f2a6fd67e2a8bf4d',
                  'f9fceca23c33cfd241368dc26a68d52ffab23bce1b42340cc7735134e9b1529f');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794493950734) <> 1 THEN
    RAISE EXCEPTION '0016 rollback refused: migration 0016_guardian_phone is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794493950734;
  IF newer > 0 THEN
    RAISE EXCEPTION '0016 rollback refused: % later migration(s) are applied after 0016; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'column app_user.phone' o WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_user' AND column_name = 'phone')
    UNION ALL SELECT 'constraint app_user_phone_e164_check' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_user_phone_e164_check')
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0016 rollback refused: the schema does not match migration 0016 (missing: %). Nothing was changed', missing;
  END IF;
END $$;
ALTER TABLE "app_user" DROP CONSTRAINT "app_user_phone_e164_check";
ALTER TABLE "app_user" DROP COLUMN "phone";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794493950734;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0016 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
