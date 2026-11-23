-- Manual rollback for migrations/0012_calendar_series.sql. It is NOT applied by `db:migrate`.
--
-- Take a backup first (stopped-instance checkpoint). Stop the application: the Stage 5E code needs 0012 and the
-- code from before Stage 5E fails on a 0012 schema, so code and schema are always rolled back together.
--
-- Everything below runs in ONE transaction, including drizzle's bookkeeping, and starts with a guard that refuses
-- (raising an error, so nothing at all is changed) unless:
--   * 0012 is recorded as applied: the drizzle.__drizzle_migrations row with created_at 1794226000000 (0012's
--     journal "when") exists, carries the hash of the reviewed 0012 file (LF or CRLF checkout), and is the only
--     row with that timestamp;
--   * 0012 is the LATEST applied migration (no row with a later created_at);
--   * every object 0012 created still exists (table, both columns, the six constraints, function and trigger);
--   * there is no series data, OR the operator explicitly accepted losing it for this session with
--       SET sportozen.allow_series_data_loss = 'on';
--     ("series data" = any calendar_series row or any calendar_event with series_id set).
-- Only 0012's own bookkeeping row is deleted, by its exact timestamp and hash, never "the newest row": a rollback
-- can therefore never remove 0011's record. If the script stops with an error, the transaction is aborted: end
-- the session (or run ROLLBACK) and nothing has changed.
--
-- What a rollback loses when series data exists: calendar_series (series versions, split lineage, series
-- metadata) and calendar_event.occurrence_date (each occurrence's original slot date). Event rows stay, with
-- data.seriesId still naming their series and data.overrides / data.cancellation inside data. A later re-apply of
-- 0012 re-links tagged rows using data.localDate, so occurrences moved individually get their current date as the
-- slot, and two occurrences of one series on the same date make the 0012 pre-flight refuse. Export calendar_series
-- and (id, series_id, occurrence_date) before accepting the loss.
BEGIN;
DO $$
DECLARE
  recorded int;
  newer int;
  series_rows int;
  linked_rows int;
  missing text;
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NULL THEN
    RAISE EXCEPTION '0012 rollback refused: no migration history (drizzle.__drizzle_migrations). Nothing was changed';
  END IF;
  SELECT count(*) INTO recorded FROM drizzle."__drizzle_migrations"
   WHERE created_at = 1794226000000
     AND hash IN ('fdbe7a95a28c474633b9eb77eced1b53c96646cb90fe2b82574df4e581e1fec4',
                  '284540648048457a3f5aa1d4ede60c285fc66275668b098620c8ef4871accd66');
  IF recorded <> 1 OR (SELECT count(*) FROM drizzle."__drizzle_migrations" WHERE created_at = 1794226000000) <> 1 THEN
    RAISE EXCEPTION '0012 rollback refused: migration 0012_calendar_series is not recorded as applied (exactly once, with the reviewed hash). Nothing was changed';
  END IF;
  SELECT count(*) INTO newer FROM drizzle."__drizzle_migrations" WHERE created_at > 1794226000000;
  IF newer > 0 THEN
    RAISE EXCEPTION '0012 rollback refused: % later migration(s) are applied after 0012; roll those back first. Nothing was changed', newer;
  END IF;
  SELECT string_agg(o, ', ') INTO missing FROM (
    SELECT 'table calendar_series' o WHERE to_regclass('public.calendar_series') IS NULL
    UNION ALL SELECT 'column calendar_event.series_id' WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'calendar_event' AND column_name = 'series_id')
    UNION ALL SELECT 'column calendar_event.occurrence_date' WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'calendar_event' AND column_name = 'occurrence_date')
    UNION ALL SELECT 'constraint ' || c FROM unnest(ARRAY['calendar_event_series_mirror', 'calendar_event_series_shape', 'calendar_event_occurrence_unique', 'calendar_event_series_fk', 'calendar_series_split_from_fk', 'calendar_series_academy_id_academy_id_fk']) c
     WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c)
    UNION ALL SELECT 'function calendar_event_series_stable' WHERE NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'calendar_event_series_stable')
    UNION ALL SELECT 'trigger calendar_event_series_stable' WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'calendar_event_series_stable')
  ) x;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0012 rollback refused: the schema does not match migration 0012 (missing: %). Nothing was changed', missing;
  END IF;
  SELECT count(*) INTO series_rows FROM "calendar_series";
  SELECT count(*) INTO linked_rows FROM "calendar_event" WHERE "series_id" IS NOT NULL;
  IF (series_rows > 0 OR linked_rows > 0) AND coalesce(current_setting('sportozen.allow_series_data_loss', true), '') <> 'on' THEN
    RAISE EXCEPTION '0012 rollback refused: % series and % linked occurrences exist; rolling back loses their series versions, split lineage and occurrence dates. Export them, then accept the loss with SET sportozen.allow_series_data_loss = ''on'' in this session. Nothing was changed', series_rows, linked_rows;
  END IF;
END $$;
DROP TRIGGER calendar_event_series_stable ON "calendar_event";
DROP FUNCTION calendar_event_series_stable();
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_series_mirror";
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_series_shape";
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_occurrence_unique";
ALTER TABLE "calendar_event" DROP CONSTRAINT "calendar_event_series_fk";
ALTER TABLE "calendar_event" DROP COLUMN "occurrence_date";
ALTER TABLE "calendar_event" DROP COLUMN "series_id";
DROP TABLE "calendar_series";
DO $$
DECLARE
  removed int;
BEGIN
  DELETE FROM drizzle."__drizzle_migrations" WHERE created_at = 1794226000000;
  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed <> 1 THEN
    RAISE EXCEPTION '0012 rollback: expected to remove exactly one bookkeeping row, found %. Nothing was changed', removed;
  END IF;
END $$;
COMMIT;
