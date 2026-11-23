-- Manual rollback for migrations/0015_auth_onboarding_and_outbox.sql. It is NOT applied by `db:migrate`.
--
-- Revert the application code FIRST: code that reads app_user onboarding columns, Better Auth query indexes,
-- or auth_email_outbox expects these schema objects to exist.
-- Take a backup first (stopped-instance checkpoint). The rollback DROPS auth_email_outbox (deleting any queued
-- or sent email outbox audit rows), the three Better Auth session/account/verification indexes, and the three
-- additive app_user onboarding columns (email_verification_required, terms_accepted_at, terms_version).
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping, and refuses (raising an error,
-- so nothing at all changes) unless:
--   * 0015 is recorded as applied with created_at = 1794483556845 and the reviewed LF/CRLF SHA-256 hash;
--   * 0015 is the LATEST applied migration;
--   * every object 0015 created still exists.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0015 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794483556845
     AND hash IN ('43e9dd1ac33815d951e77592d03130c59328abdc2c24ccfdc8de40756e83685f',
                  'de5c0fde86ba9ad194426d40b87426a1fd918a98c3acb75db3a094b4b19d7bfd');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794483556845) <> 1 THEN
    RAISE EXCEPTION '0015 rollback refused: migration 0015_auth_onboarding_and_outbox is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794483556845;
  IF newer > 0 THEN
    RAISE EXCEPTION '0015 rollback refused: % later migration(s) are applied after 0015; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'table auth_email_outbox' o WHERE to_regclass('public.auth_email_outbox') IS NULL
    UNION ALL SELECT 'column app_user.email_verification_required' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_user' AND column_name = 'email_verification_required'
    )
    UNION ALL SELECT 'column app_user.terms_accepted_at' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_user' AND column_name = 'terms_accepted_at'
    )
    UNION ALL SELECT 'column app_user.terms_version' WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_user' AND column_name = 'terms_version'
    )
    UNION ALL SELECT 'index auth_account_user_provider_idx' WHERE to_regclass('public.auth_account_user_provider_idx') IS NULL
    UNION ALL SELECT 'index auth_session_user_idx' WHERE to_regclass('public.auth_session_user_idx') IS NULL
    UNION ALL SELECT 'index auth_verification_identifier_idx' WHERE to_regclass('public.auth_verification_identifier_idx') IS NULL
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0015 rollback refused: the schema does not match migration 0015 (missing: %). Nothing was changed', missing;
  END IF;
END $$;
DROP INDEX "auth_verification_identifier_idx";
DROP INDEX "auth_session_user_idx";
DROP INDEX "auth_account_user_provider_idx";
DROP TABLE "auth_email_outbox";
ALTER TABLE "app_user"
  DROP COLUMN "terms_version",
  DROP COLUMN "terms_accepted_at",
  DROP COLUMN "email_verification_required";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794483556845;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0015 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
