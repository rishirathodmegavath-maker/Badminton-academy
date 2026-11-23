-- Stage 5C: payment attempts and reference integrity.
--   * reference_key: canonical form of the submitted reference, computed by the database (the
--     submitted text in "reference" is kept unchanged).
--   * the exact-text unique rule (academy_id, reference) is replaced by a unique rule on the canonical
--     form that covers only LIVE attempts (awaiting a decision or verified) and references rejected
--     as INVALID. An attempt rejected as CORRECTABLE no longer blocks a new attempt.
--   * rejected attempts become immutable in the database; at most three attempts per invoice may wait
--     for a decision at once.
-- Nothing is deleted, merged or rewritten. If existing rows would break the new rules the migration
-- stops (one transaction: the database is left exactly as it was) and names the conflicting rows.
ALTER TABLE "payment_reference" ADD COLUMN "reference_key" text GENERATED ALWAYS AS (translate(btrim(regexp_replace(normalize("reference", NFKC), '[ \t\n\r\f\v]+', ' ', 'g'), ' '), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_reference" ADD COLUMN "rejection_kind" text;--> statement-breakpoint
-- Pre-flight: every status is one the application knows, and no two live attempts of one academy share
-- a canonical reference (possible before, because the old rule compared exact text).
DO $$
DECLARE
  unknown text;
  conflicts text;
BEGIN
  SELECT string_agg(DISTINCT "status", ', ') INTO unknown FROM "payment_reference"
   WHERE "status" NOT IN ('SUBMITTED', 'VERIFIED', 'REJECTED');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION '0010 pre-flight: payment_reference has unknown statuses (%); nothing was changed', unknown;
  END IF;
  SELECT string_agg(format('academy %s: %s', "academy_id", ids), '; ') INTO conflicts FROM (
    SELECT "academy_id", string_agg("id", ', ' ORDER BY "id") AS ids
      FROM "payment_reference" WHERE "status" IN ('SUBMITTED', 'VERIFIED')
     GROUP BY "academy_id", "reference_key" HAVING count(*) > 1
  ) AS dup;
  IF conflicts IS NOT NULL THEN
    RAISE EXCEPTION '0010 pre-flight: live payment attempts share a reference once case and spacing are ignored (%). Review them before migrating; nothing was changed', conflicts;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "payment_reference" DROP CONSTRAINT "payment_reference_academy_id_reference_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reference_live_key" ON "payment_reference" USING btree ("academy_id","reference_key") WHERE "payment_reference"."status" in ('SUBMITTED', 'VERIFIED') or "payment_reference"."rejection_kind" = 'INVALID';--> statement-breakpoint
CREATE INDEX "payment_reference_invoice_status" ON "payment_reference" USING btree ("academy_id","invoice_id","status");--> statement-breakpoint
ALTER TABLE "payment_reference" ADD CONSTRAINT "payment_reference_status_check" CHECK ("payment_reference"."status" in ('SUBMITTED', 'VERIFIED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "payment_reference" ADD CONSTRAINT "payment_reference_rejection_kind_check" CHECK ("payment_reference"."rejection_kind" is null or ("payment_reference"."status" = 'REJECTED' and "payment_reference"."rejection_kind" in ('CORRECTABLE', 'INVALID')));--> statement-breakpoint
-- A rejected attempt is history: it is never changed or removed (a correction is a new attempt).
CREATE FUNCTION payment_reference_rejected_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_reference: a rejected payment attempt is immutable (% refused)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER payment_reference_rejected_no_change BEFORE UPDATE OR DELETE ON "payment_reference"
  FOR EACH ROW WHEN (OLD."status" = 'REJECTED') EXECUTE FUNCTION payment_reference_rejected_immutable();--> statement-breakpoint
-- At most three attempts of one invoice may await a decision. The invoice row is locked first, so
-- concurrent submissions for the same invoice are counted one after the other.
CREATE FUNCTION payment_reference_pending_limit() RETURNS trigger AS $$
DECLARE
  pending integer;
BEGIN
  PERFORM 1 FROM "invoice" WHERE "academy_id" = NEW."academy_id" AND "id" = NEW."invoice_id" FOR UPDATE;
  SELECT count(*) INTO pending FROM "payment_reference"
   WHERE "academy_id" = NEW."academy_id" AND "invoice_id" = NEW."invoice_id" AND "status" = 'SUBMITTED';
  IF pending >= 3 THEN
    RAISE EXCEPTION 'PAYMENT_PENDING_LIMIT: invoice % already has % attempts awaiting a decision', NEW."invoice_id", pending USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER payment_reference_pending_limit BEFORE INSERT ON "payment_reference"
  FOR EACH ROW WHEN (NEW."status" = 'SUBMITTED') EXECUTE FUNCTION payment_reference_pending_limit();
