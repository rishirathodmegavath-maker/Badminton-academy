CREATE TABLE "access_event" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"category" text NOT NULL,
	"operation" text NOT NULL,
	"outcome" text NOT NULL,
	"resource_id" text,
	"player_id" text,
	"channel" text NOT NULL,
	"request_id" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "access_event_outcome_check" CHECK ("access_event"."outcome" in ('SUCCESS', 'DENIED')),
	CONSTRAINT "access_event_operation_check" CHECK ("access_event"."operation" in ('VIEW', 'LIST', 'BULK', 'DOWNLOAD', 'PDF', 'HISTORICAL', 'THROTTLED')),
	CONSTRAINT "access_event_category_check" CHECK ("access_event"."category" in ('WORKSPACE', 'CONSENT', 'REPORT', 'NUTRITION', 'MEDIA', 'FINANCE', 'ACCOUNT_SECURITY', 'AUDIT_LOG', 'TRAINING'))
);
--> statement-breakpoint
ALTER TABLE "access_event" ADD CONSTRAINT "access_event_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_event_academy_created" ON "access_event" USING btree ("academy_id","created_at","id");--> statement-breakpoint
CREATE INDEX "access_event_actor_created" ON "access_event" USING btree ("academy_id","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "access_event_player_created" ON "access_event" USING btree ("academy_id","player_id","created_at");--> statement-breakpoint
CREATE INDEX "access_event_category_created" ON "access_event" USING btree ("academy_id","category","created_at");
--> statement-breakpoint
-- The access history is append-only: the application only ever INSERTs. These triggers make that a database
-- guarantee, also against direct SQL by the application's own role (a superuser or the table owner can still
-- drop the trigger; see ACCESS_AUDIT.md for the deployment-level protection). Phase 8 must decide how
-- retention and erasure work for this table deliberately; nothing here can delete a row by accident.
CREATE FUNCTION access_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'access_event is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER access_event_no_change BEFORE UPDATE OR DELETE ON "access_event"
  FOR EACH ROW EXECUTE FUNCTION access_event_append_only();
--> statement-breakpoint
CREATE TRIGGER access_event_no_truncate BEFORE TRUNCATE ON "access_event"
  FOR EACH STATEMENT EXECUTE FUNCTION access_event_append_only();
