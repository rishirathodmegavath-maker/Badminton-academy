-- Manual rollback for migrations/0010_payment_attempts.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first. The rollback is only safe while the Stage 5C features have not been used: it
-- STOPS, changing nothing, if
--   * any attempt has a rejection kind (that decision would be lost with the column), or
--   * two attempts of one academy share the exact same reference text (a correctable rejection was
--     resubmitted), because the old exact-text unique rule could not be restored without deleting one.
-- It never deletes or rewrites payment rows.
-- Afterwards remove drizzle's bookkeeping row so a later `db:migrate` re-applies 0010 cleanly:
--   delete from drizzle.__drizzle_migrations
--    where created_at = (select max(created_at) from drizzle.__drizzle_migrations);
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "payment_reference" WHERE "rejection_kind" IS NOT NULL) THEN
    RAISE EXCEPTION 'payment_reference has recorded rejection kinds; rolling back 0010 would discard those decisions';
  END IF;
  IF EXISTS (SELECT 1 FROM "payment_reference" GROUP BY "academy_id", "reference" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'payment_reference has resubmitted references; the exact-text unique rule of 0002 cannot be restored without deleting attempts';
  END IF;
END $$;
DROP TRIGGER payment_reference_pending_limit ON "payment_reference";
DROP TRIGGER payment_reference_rejected_no_change ON "payment_reference";
DROP FUNCTION payment_reference_pending_limit();
DROP FUNCTION payment_reference_rejected_immutable();
ALTER TABLE "payment_reference" DROP CONSTRAINT "payment_reference_rejection_kind_check";
ALTER TABLE "payment_reference" DROP CONSTRAINT "payment_reference_status_check";
DROP INDEX "payment_reference_invoice_status";
DROP INDEX "payment_reference_live_key";
ALTER TABLE "payment_reference" DROP COLUMN "rejection_kind";
ALTER TABLE "payment_reference" DROP COLUMN "reference_key";
ALTER TABLE "payment_reference" ADD CONSTRAINT "payment_reference_academy_id_reference_unique" UNIQUE("academy_id","reference");
COMMIT;
