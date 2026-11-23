-- RC-3: role validation and the last-active-owner invariant (DATABASE_AND_MIGRATION_DESIGN.md section 2.1,
-- hardened for review findings F-01 and F-02 of RC3_GEMINI_INDEPENDENT_FINAL_REVIEW.md).
-- Before: membership.role was free text, and only the application (RC-2 saveMember / owner step-up) prevented an
-- academy from losing its last active owner; a direct SQL statement or script could do either unchecked.
-- This migration adds:
--   * membership_role_known (CHECK): role is one of the eight stored roles (STORED_ROLES in
--     src/modules/identity/authority.ts);
--   * membership_owner_presence (UPDATE) and membership_owner_presence_delete (DELETE), deferred constraint
--     triggers: at COMMIT, every academy that lost an active OWNER row in the transaction (deleted, demoted,
--     deactivated or moved to another academy), and both academies of any membership moved between academies,
--     must still have at least one active OWNER; otherwise the commit fails with OWNER_REQUIRED (SQLSTATE 23514
--     check_violation). Deferral lets one transaction hand ownership over (add the new owner, then remove the old
--     one) in either order.
--   * Serialization (F-02): before checking an academy, the trigger writes that academy row (a no-op UPDATE), in
--     ascending id order when a move touches two academies. Two transactions removing different owners of the same
--     academy therefore queue on the academy row instead of both checking before either commits:
--       - READ COMMITTED: the second waits, then checks with a fresh snapshot that includes the first commit;
--       - REPEATABLE READ / SERIALIZABLE: the second fails with 40001 (could not serialize access due to concurrent
--         update); a lock without a write would let it check its old snapshot and commit (write skew).
--     The application (RC-2 unit()) already holds this row FOR UPDATE for the whole transaction, so its own lock
--     order (academy, then memberships) is unchanged.
--   * membership_owner_presence_truncate: TRUNCATE (which fires no row trigger) is refused while any active OWNER
--     exists (same convention as the append-only tables of 0008 and 0009).
-- No existing row is changed. Two pre-flights stop the migration (one transaction: nothing is changed) and name the
-- offending values when existing data would violate either rule.
-- Pre-flight A: unknown membership role values.
DO $$
DECLARE
  bad_roles text;
BEGIN
  SELECT string_agg(DISTINCT role, ', ') INTO bad_roles
    FROM membership
   WHERE role NOT IN ('OWNER','ADMIN','HEAD_COACH','COACH','FINANCE','NUTRITION_PRO','GUARDIAN','ADULT_PLAYER');
  IF bad_roles IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_PREFLIGHT_FAILED: Unknown membership role values found: (%). Fix invalid roles before applying migration 0013.', bad_roles;
  END IF;
END $$;--> statement-breakpoint
-- Pre-flight B: academies with members but no active owner.
DO $$
DECLARE
  ownerless_academies text;
BEGIN
  SELECT string_agg(a.id, ', ' ORDER BY a.id) INTO ownerless_academies
    FROM academy a
   WHERE EXISTS (SELECT 1 FROM membership m WHERE m.academy_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM membership m WHERE m.academy_id = a.id AND m.role = 'OWNER' AND m.active);
  IF ownerless_academies IS NOT NULL THEN
    RAISE EXCEPTION 'MIGRATION_PREFLIGHT_FAILED: Academies without an active owner found: (%). Restore an active owner before applying migration 0013.', ownerless_academies;
  END IF;
END $$;--> statement-breakpoint
-- Part A: CHECK constraint on membership.role (mirrored by schema.ts, so Drizzle's snapshot carries it).
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_known" CHECK ("membership"."role" IN ('OWNER','ADMIN','HEAD_COACH','COACH','FINANCE','NUTRITION_PRO','GUARDIAN','ADULT_PLAYER'));--> statement-breakpoint
-- Part B: function and deferred constraint triggers for the last-active-owner invariant.
CREATE FUNCTION membership_owner_presence() RETURNS trigger AS $$
DECLARE
  affected text[] := ARRAY[]::text[];
  target text;
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.role = 'OWNER' AND OLD.active) THEN
    affected := affected || OLD.academy_id;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.academy_id IS DISTINCT FROM OLD.academy_id THEN
    -- A move: the source and the destination must both still have an active owner.
    affected := affected || OLD.academy_id || NEW.academy_id;
  END IF;
  FOR target IN SELECT DISTINCT x FROM unnest(affected) AS x ORDER BY x LOOP
    -- Serialization point (see the header): wait for, or conflict with, any other transaction that is checking or
    -- has just checked this academy. A no-op write, so that REPEATABLE READ / SERIALIZABLE transactions conflict too.
    UPDATE academy SET name = name WHERE id = target;
    IF NOT EXISTS (
      SELECT 1 FROM membership
       WHERE academy_id = target
         AND role = 'OWNER'
         AND active = true
    ) THEN
      RAISE EXCEPTION 'OWNER_REQUIRED: Academy % must retain at least one active owner.', target
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER membership_owner_presence
  AFTER UPDATE OF role, active, academy_id ON membership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN ((OLD.role = 'OWNER' AND OLD.active = true) OR OLD.academy_id IS DISTINCT FROM NEW.academy_id)
  EXECUTE FUNCTION membership_owner_presence();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER membership_owner_presence_delete
  AFTER DELETE ON membership
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.role = 'OWNER' AND OLD.active = true)
  EXECUTE FUNCTION membership_owner_presence();--> statement-breakpoint
CREATE FUNCTION membership_owner_presence_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM membership WHERE role = 'OWNER' AND active = true) THEN
    RAISE EXCEPTION 'OWNER_REQUIRED: TRUNCATE of membership would remove every active owner.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER membership_owner_presence_truncate BEFORE TRUNCATE ON membership
  FOR EACH STATEMENT EXECUTE FUNCTION membership_owner_presence_truncate();
