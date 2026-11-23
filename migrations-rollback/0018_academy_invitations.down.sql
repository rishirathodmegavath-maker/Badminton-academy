-- Manual rollback for migrations/0018_academy_invitations.sql. It is NOT applied by `db:migrate`.
--
-- Revert the application code FIRST: code that carries this change creates, lists, revokes and accepts invitations in
-- academy_invitation and would fail without it.
-- Take a backup first (stopped-instance checkpoint). The rollback DESTROYS the invitation table, that is every
-- invitation and the history of who invited whom, who accepted and who revoked. Memberships that were created by an
-- accepted invitation are NOT touched (they are ordinary memberships). Because that history is real data, the script
-- REFUSES while any invitation exists unless the same session first runs:   SET sportozen.rollback_invitations = 'destroy';
-- Nothing else is touched: no account, membership, role, session, player or academy row changes.
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping (the project's guarded rollback
-- convention, as for 0012 to 0017), and starts with a guard that refuses (raising an error, so nothing at all is
-- changed) unless:
--   * 0018 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794513818712 (0018's journal
--     "when") exists, carries the hash of the reviewed 0018 file (LF or CRLF checkout), and is the only row with
--     that timestamp;
--   * 0018 is the LATEST applied migration (no row with a later created_at);
--   * every object 0018 created still exists;
--   * no invitation exists, or the destroy confirmation above was given.
-- Only 0018's own bookkeeping row is deleted, by its exact timestamp, never "the newest row". If the script stops
-- with an error, the transaction is aborted: end the session (or run ROLLBACK) and nothing has changed.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  missing text;
  invitations int;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0018 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794513818712
     AND hash IN ('a3332675d30179809934e17ee8fd8bda49bf5cbd1cc9425ab4224608c52256a0',
                  'e973b87f4965c7fcb9951b3500d1ee4e7d6d76d6398c7dad37626e0d34d641b5');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794513818712) <> 1 THEN
    RAISE EXCEPTION '0018 rollback refused: migration 0018_academy_invitations is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794513818712;
  IF newer > 0 THEN
    RAISE EXCEPTION '0018 rollback refused: % later migration(s) are applied after 0018; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'table academy_invitation' o WHERE to_regclass('public.academy_invitation') IS NULL
    UNION ALL SELECT 'trigger academy_invitation_guard' WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'academy_invitation_guard' AND NOT tgisinternal)
    UNION ALL SELECT 'trigger academy_invitation_no_truncate' WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'academy_invitation_no_truncate' AND NOT tgisinternal)
    UNION ALL SELECT 'function academy_invitation_guard' WHERE to_regprocedure('academy_invitation_guard()') IS NULL
    UNION ALL SELECT 'function academy_invitation_no_truncate' WHERE to_regprocedure('academy_invitation_no_truncate()') IS NULL
    UNION ALL SELECT 'constraint academy_invitation_shape' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academy_invitation_shape')
    UNION ALL SELECT 'constraint academy_invitation_inviter_fk' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'academy_invitation_inviter_fk')
    UNION ALL SELECT 'index academy_invitation_one_pending_person' WHERE to_regclass('public.academy_invitation_one_pending_person') IS NULL
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0018 rollback refused: the schema does not match migration 0018 (missing: %). Nothing was changed', missing;
  END IF;
  SELECT count(*) INTO invitations FROM academy_invitation;
  IF invitations > 0 AND coalesce(current_setting('sportozen.rollback_invitations', true), '') <> 'destroy' THEN
    RAISE EXCEPTION '0018 rollback refused: % invitation(s) exist and would be destroyed. Back them up, then run SET sportozen.rollback_invitations = ''destroy''; in the same session and repeat. Nothing was changed', invitations;
  END IF;
END $$;
-- The triggers refuse deleting and truncating invitations; dropping the table removes them with it.
DROP TABLE "academy_invitation";
DROP FUNCTION academy_invitation_guard();
DROP FUNCTION academy_invitation_no_truncate();
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794513818712;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0018 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
