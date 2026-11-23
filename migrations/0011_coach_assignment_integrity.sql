-- Stage 5D: coach deactivation and batch assignment integrity.
-- Invariant: every batch is coached by an ACTIVE member of the same academy whose role can coach
-- (OWNER, ADMIN, HEAD_COACH, COACH). The existing foreign key (batch -> membership) already ties a
-- batch to a membership of its own academy; these triggers add "active" and "can coach":
--   * batch_coach_must_coach: a batch cannot be created with, or moved to, someone who cannot coach;
--   * membership_coach_assignments: a coach cannot be deactivated, or given a role that cannot coach,
--     while any batch is still assigned to them (the application first hands the batches to a
--     replacement in the same transaction).
-- Concurrency (READ COMMITTED, the default): the batch trigger takes a share lock on the coach's
-- membership row, so a concurrent deactivation either waits for the assignment to commit and then
-- sees it, or commits first and the assignment is refused.
-- No schema, column or row changes. If an existing batch already breaks the rule the migration stops
-- (one transaction: the database is left exactly as it was) and names the batches.
DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(format('academy %s batch %s (coach %s)', b."academy_id", b."id", b."coach_id"), '; ' ORDER BY b."academy_id", b."id")
    INTO broken
    FROM "batch" b
    LEFT JOIN "membership" m ON m."academy_id" = b."academy_id" AND m."user_id" = b."coach_id"
   WHERE m."user_id" IS NULL OR NOT m."active" OR m."role" NOT IN ('OWNER', 'ADMIN', 'HEAD_COACH', 'COACH');
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION '0011 pre-flight: batches are assigned to an inactive or non-coaching member (%). Assign them to an active coach in Settings before migrating; nothing was changed', broken;
  END IF;
END $$;--> statement-breakpoint
CREATE FUNCTION batch_coach_must_coach() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."coach_id" = OLD."coach_id" AND NEW."academy_id" = OLD."academy_id" THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "membership"
   WHERE "academy_id" = NEW."academy_id" AND "user_id" = NEW."coach_id"
     AND "active" AND "role" IN ('OWNER', 'ADMIN', 'HEAD_COACH', 'COACH')
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COACH_ASSIGNMENT_INVALID: batch % must be coached by an active coaching member of academy %', NEW."id", NEW."academy_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER batch_coach_must_coach BEFORE INSERT OR UPDATE OF "coach_id", "academy_id" ON "batch"
  FOR EACH ROW EXECUTE FUNCTION batch_coach_must_coach();--> statement-breakpoint
CREATE FUNCTION membership_coach_assignments() RETURNS trigger AS $$
DECLARE
  assigned text;
BEGIN
  IF NEW."active" AND NEW."role" IN ('OWNER', 'ADMIN', 'HEAD_COACH', 'COACH')
     AND NEW."academy_id" = OLD."academy_id" AND NEW."user_id" = OLD."user_id" THEN
    RETURN NEW;
  END IF;
  SELECT string_agg("id", ', ' ORDER BY "id") INTO assigned FROM "batch"
   WHERE "academy_id" = OLD."academy_id" AND "coach_id" = OLD."user_id";
  IF assigned IS NOT NULL THEN
    RAISE EXCEPTION 'COACH_REASSIGNMENT_REQUIRED: member % of academy % still coaches batch(es) %; reassign them first', OLD."user_id", OLD."academy_id", assigned USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER membership_coach_assignments BEFORE UPDATE OF "active", "role", "academy_id", "user_id" ON "membership"
  FOR EACH ROW WHEN (OLD."active" AND OLD."role" IN ('OWNER', 'ADMIN', 'HEAD_COACH', 'COACH'))
  EXECUTE FUNCTION membership_coach_assignments();
