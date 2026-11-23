-- Manual rollback for migrations/0017_multi_academy_session.sql. It is NOT applied by `db:migrate`.
--
-- Revert the application code FIRST: code that carries this change reads membership.display_name and resolves the
-- active academy from auth_session_academy on every request, and would fail without them.
-- Take a backup first (stopped-instance checkpoint). The rollback DESTROYS:
--   * auth_session_academy (which academy each open session was working in; people simply choose again), and
--   * every academy-specific display name (membership.display_name). Because that is real data, the script REFUSES
--     while any display name exists unless the same session first runs:   SET sportozen.rollback_display_names = 'destroy';
-- It also drops the unique constraint auth_session_id_user_unique and the CHECK membership_display_name_length.
-- Nothing else is touched: no account, membership, role, session or academy row changes.
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping (the project's guarded rollback
-- convention, as for 0012 to 0016), and starts with a guard that refuses (raising an error, so nothing at all is
-- changed) unless:
--   * 0017 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794508151765 (0017's journal
--     "when") exists, carries the hash of the reviewed 0017 file (LF or CRLF checkout), and is the only row with
--     that timestamp;
--   * 0017 is the LATEST applied migration (no row with a later created_at);
--   * every object 0017 created still exists;
--   * no display name exists, or the destroy confirmation above was given.
-- Only 0017's own bookkeeping row is deleted, by its exact timestamp, never "the newest row". If the script stops
-- with an error, the transaction is aborted: end the session (or run ROLLBACK) and nothing has changed.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
  names int;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0017 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794508151765
     AND hash IN ('eafd7456f0f5888b503be73dbb89ccb41343eb0099d2d6f1eb4a66bf82f7481d',
                  '2a41144b79b36d70003016488038c4cf67762ce21eca07aaf295a1d30038c9d5');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794508151765) <> 1 THEN
    RAISE EXCEPTION '0017 rollback refused: migration 0017_multi_academy_session is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794508151765;
  IF newer > 0 THEN
    RAISE EXCEPTION '0017 rollback refused: % later migration(s) are applied after 0017; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'table auth_session_academy' o WHERE to_regclass('public.auth_session_academy') IS NULL
    UNION ALL SELECT 'column membership.display_name' WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'membership' AND column_name = 'display_name')
    UNION ALL SELECT 'constraint auth_session_id_user_unique' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_session_id_user_unique')
    UNION ALL SELECT 'constraint membership_display_name_length' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_display_name_length')
    UNION ALL SELECT 'constraint auth_session_academy_session_fk' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_session_academy_session_fk')
    UNION ALL SELECT 'constraint auth_session_academy_membership_fk' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auth_session_academy_membership_fk')
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0017 rollback refused: the schema does not match migration 0017 (missing: %). Nothing was changed', missing;
  END IF;
  SELECT count(*) INTO names FROM membership WHERE display_name IS NOT NULL;
  IF names > 0 AND coalesce(current_setting('sportozen.rollback_display_names', true), '') <> 'destroy' THEN
    RAISE EXCEPTION '0017 rollback refused: % academy display name(s) exist and would be destroyed. Back them up, then run SET sportozen.rollback_display_names = ''destroy''; in the same session and repeat. Nothing was changed', names;
  END IF;
END $$;
DROP TABLE "auth_session_academy";
ALTER TABLE "membership" DROP CONSTRAINT "membership_display_name_length";
ALTER TABLE "membership" DROP COLUMN "display_name";
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_id_user_unique";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794508151765;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0017 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
