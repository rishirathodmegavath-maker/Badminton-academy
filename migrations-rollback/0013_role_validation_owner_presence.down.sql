-- Manual rollback for migrations/0013_role_validation_owner_presence.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first (stopped-instance checkpoint). 0013 added no table, column or row: only the CHECK constraint
-- membership_role_known, the functions membership_owner_presence() and membership_owner_presence_truncate(), the
-- deferred constraint triggers membership_owner_presence (UPDATE) and membership_owner_presence_delete (DELETE), and
-- the statement trigger membership_owner_presence_truncate. The rollback removes exactly those and touches no data.
-- The RC-2 application checks (saveMember last-owner rule under the academy lock, owner step-up) are unaffected and
-- keep protecting the last owner; only the database backstop is removed.
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping, and starts with a guard that refuses
-- (raising an error, so nothing at all is changed) unless:
--   * 0013 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794379117705 (0013's
--     journal "when") exists, carries the hash of the reviewed 0013 file (LF or CRLF checkout), and is the only
--     row with that timestamp;
--   * 0013 is the LATEST applied migration (no row with a later created_at);
--   * every object 0013 created still exists (the constraint, both functions and the three triggers).
-- Only 0013's own bookkeeping row is deleted, by its exact timestamp, never "the newest row": a rollback can
-- therefore never remove 0012's record. If the script stops with an error, the transaction is aborted: end the
-- session (or run ROLLBACK) and nothing has changed.
-- (This replaces the unguarded DROP ... IF EXISTS sketch of DATABASE_AND_MIGRATION_DESIGN.md section 2.2 with the
-- project's guarded rollback convention, as for 0012.)
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0013 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794379117705
     AND hash IN ('a06aaea30b1b701775fe93c9d1eb67cf1f4edc16fd6d8acbec17e54979b18352',
                  'c578db18feb30196125937be37678447cdc6ab7c0d92240ff3f7abf91a3b435f');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794379117705) <> 1 THEN
    RAISE EXCEPTION '0013 rollback refused: migration 0013_role_validation_owner_presence is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794379117705;
  IF newer > 0 THEN
    RAISE EXCEPTION '0013 rollback refused: % later migration(s) are applied after 0013; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'constraint membership_role_known' o
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'membership_role_known' AND conrelid = 'public.membership'::regclass AND contype = 'c')
    UNION ALL SELECT 'function ' || f FROM unnest(ARRAY['membership_owner_presence', 'membership_owner_presence_truncate']) f
     WHERE NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = f AND pronamespace = 'public'::regnamespace)
    UNION ALL SELECT 'trigger ' || g FROM unnest(ARRAY['membership_owner_presence', 'membership_owner_presence_delete', 'membership_owner_presence_truncate']) g
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = g AND tgrelid = 'public.membership'::regclass)
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0013 rollback refused: the schema does not match migration 0013 (missing: %). Nothing was changed', missing;
  END IF;
END $$;
DROP TRIGGER membership_owner_presence_truncate ON "membership";
DROP TRIGGER membership_owner_presence_delete ON "membership";
DROP TRIGGER membership_owner_presence ON "membership";
DROP FUNCTION membership_owner_presence_truncate();
DROP FUNCTION membership_owner_presence();
ALTER TABLE "membership" DROP CONSTRAINT "membership_role_known";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794379117705;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0013 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
