-- Stage 5E: recurring calendar integrity.
-- Before: a recurring series was only a "seriesId" tag inside calendar_event.data. Editing or cancelling one
-- occurrence rewrote data with seriesId = null, silently detaching it, and nothing else recorded membership.
-- This migration promotes series membership to real, constrained columns:
--   * calendar_series: one row per series (stable identity, optimistic version, split lineage);
--   * calendar_event.series_id / occurrence_date: the series an occurrence belongs to and the date of its
--     slot in that series (stable occurrence identity, unique per series, never changed afterwards);
--   * calendar_event_series_stable (trigger): an occurrence can never be detached from its series, attached
--     later, or re-dated; it can only move to a series split from its own ("this and following").
--   * data.seriesId stays as a mirror of series_id (CHECK), so existing readers keep working.
-- Existing rows: occurrences that still carry data.seriesId are linked to a new calendar_series row with the
-- same id, occurrence_date = their stored local date (they were never edited: any edit removed the tag).
-- No row content, status or version changes. Occurrences detached by the old defect cannot be re-linked
-- automatically and stay one-off events. If the existing tags are ambiguous the migration stops (one
-- transaction: nothing is changed) and names the offending series.
DO $$
DECLARE
  broken text;
BEGIN
  SELECT string_agg(format('academy %s event %s', "academy_id", "id"), '; ' ORDER BY "academy_id", "id")
    INTO broken
    FROM "calendar_event"
   WHERE jsonb_typeof("data"->'seriesId') NOT IN ('string', 'null')
      OR ("data"->>'seriesId' IS NOT NULL AND (btrim("data"->>'seriesId') = '' OR coalesce("data"->>'localDate', '') !~ '^\d{4}-\d{2}-\d{2}$'));
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION '0012 pre-flight: recurring events with an unusable series tag or local date (%). Nothing was changed', broken;
  END IF;
  SELECT string_agg(format('series %s', s), '; ' ORDER BY s)
    INTO broken
    FROM (SELECT "data"->>'seriesId' AS s FROM "calendar_event" WHERE "data"->>'seriesId' IS NOT NULL
           GROUP BY 1 HAVING count(DISTINCT "academy_id") > 1 OR count(DISTINCT "kind") > 1) x;
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION '0012 pre-flight: a series tag spans academies or event kinds (%). Nothing was changed', broken;
  END IF;
  SELECT string_agg(format('series %s on %s', s, d), '; ' ORDER BY s, d)
    INTO broken
    FROM (SELECT "data"->>'seriesId' AS s, "data"->>'localDate' AS d FROM "calendar_event" WHERE "data"->>'seriesId' IS NOT NULL
           GROUP BY 1, 2 HAVING count(*) > 1) x;
  IF broken IS NOT NULL THEN
    RAISE EXCEPTION '0012 pre-flight: a series has two occurrences on the same date (%). Nothing was changed', broken;
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "calendar_series" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"split_from" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_series_academy_id_id_unique" UNIQUE("academy_id","id")
);--> statement-breakpoint
ALTER TABLE "calendar_series" ADD CONSTRAINT "calendar_series_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_series" ADD CONSTRAINT "calendar_series_split_from_fk" FOREIGN KEY ("academy_id","split_from") REFERENCES "public"."calendar_series"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD COLUMN "series_id" text;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD COLUMN "occurrence_date" date;--> statement-breakpoint
INSERT INTO "calendar_series" ("id", "academy_id", "version", "kind", "split_from", "data")
SELECT "data"->>'seriesId', min("academy_id"), 1, min("kind"), NULL,
       jsonb_build_object('origin', 'MIGRATED', 'firstDate', min("data"->>'localDate'), 'count', count(*), 'interval', 1)
  FROM "calendar_event"
 WHERE "data"->>'seriesId' IS NOT NULL
 GROUP BY "data"->>'seriesId';--> statement-breakpoint
UPDATE "calendar_event"
   SET "series_id" = "data"->>'seriesId', "occurrence_date" = ("data"->>'localDate')::date
 WHERE "data"->>'seriesId' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_series_fk" FOREIGN KEY ("academy_id","series_id") REFERENCES "public"."calendar_series"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_occurrence_unique" UNIQUE("academy_id","series_id","occurrence_date");--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_series_shape" CHECK (("series_id" IS NULL) = ("occurrence_date" IS NULL));--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_series_mirror" CHECK ("series_id" IS NOT DISTINCT FROM ("data"->>'seriesId'));--> statement-breakpoint
CREATE FUNCTION calendar_event_series_stable() RETURNS trigger AS $$
BEGIN
  IF NEW."series_id" IS NOT DISTINCT FROM OLD."series_id" AND NEW."occurrence_date" IS NOT DISTINCT FROM OLD."occurrence_date" THEN
    RETURN NEW;
  END IF;
  IF OLD."series_id" IS NULL THEN
    RAISE EXCEPTION 'SERIES_IDENTITY_IMMUTABLE: event % is not part of a series and cannot be attached to one', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."series_id" IS NULL THEN
    RAISE EXCEPTION 'SERIES_IDENTITY_IMMUTABLE: event % cannot be detached from series %', OLD."id", OLD."series_id" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."occurrence_date" IS DISTINCT FROM OLD."occurrence_date" THEN
    RAISE EXCEPTION 'SERIES_IDENTITY_IMMUTABLE: the occurrence date of event % cannot change', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  PERFORM 1 FROM "calendar_series"
   WHERE "academy_id" = OLD."academy_id" AND "id" = NEW."series_id" AND "split_from" = OLD."series_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SERIES_IDENTITY_IMMUTABLE: event % can only move to a series split from %', OLD."id", OLD."series_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER calendar_event_series_stable BEFORE UPDATE OF "series_id", "occurrence_date" ON "calendar_event"
  FOR EACH ROW EXECUTE FUNCTION calendar_event_series_stable();
