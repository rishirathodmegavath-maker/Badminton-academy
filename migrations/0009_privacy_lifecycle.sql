CREATE TABLE "erasure_event" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"request_id" text NOT NULL,
	"at" timestamp DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_id" text,
	"actor_role" text,
	"reason" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erasure_request" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"subject_type" text DEFAULT 'PLAYER' NOT NULL,
	"player_id" text NOT NULL,
	"source" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview_at" timestamp,
	"reviewed_by" text,
	"reviewed_at" timestamp,
	"review_reason" text,
	"execute_after" timestamp,
	"plan" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"locked_until" timestamp,
	"locked_by" text,
	"blocked_reason" text,
	"failure_code" text,
	"completed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "erasure_request_status_check" CHECK ("erasure_request"."status" in ('PREVIEW_READY', 'GRACE_PERIOD', 'PROCESSING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'BLOCKED', 'FAILED')),
	CONSTRAINT "erasure_request_subject_check" CHECK ("erasure_request"."subject_type" = 'PLAYER')
);
--> statement-breakpoint
CREATE TABLE "legal_hold" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"scope" text NOT NULL,
	"player_id" text,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"released_by" text,
	"released_at" timestamp,
	"release_reason" text,
	CONSTRAINT "legal_hold_scope_check" CHECK (("legal_hold"."scope" = 'ACADEMY' and "legal_hold"."player_id" is null) or ("legal_hold"."scope" = 'PLAYER' and "legal_hold"."player_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "retention_policy" (
	"academy_id" text NOT NULL,
	"category" text NOT NULL,
	"status" text DEFAULT 'APPROVED' NOT NULL,
	"action" text NOT NULL,
	"retention_days" integer,
	"basis" text NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_academy_id_category_pk" PRIMARY KEY("academy_id","category"),
	CONSTRAINT "retention_policy_status_check" CHECK ("retention_policy"."status" in ('APPROVED', 'SUSPENDED')),
	CONSTRAINT "retention_policy_action_check" CHECK ("retention_policy"."action" in ('ERASE', 'ANONYMIZE')),
	CONSTRAINT "retention_policy_days_check" CHECK ("retention_policy"."retention_days" is null or "retention_policy"."retention_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "storage_deletion" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"request_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"done_at" timestamp,
	CONSTRAINT "storage_deletion_status_check" CHECK ("storage_deletion"."status" in ('PENDING', 'DONE', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "access_event" DROP CONSTRAINT "access_event_category_check";--> statement-breakpoint
ALTER TABLE "erasure_event" ADD CONSTRAINT "erasure_event_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_event" ADD CONSTRAINT "erasure_event_request_id_erasure_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."erasure_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_request" ADD CONSTRAINT "erasure_request_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_hold" ADD CONSTRAINT "legal_hold_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policy" ADD CONSTRAINT "retention_policy_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_deletion" ADD CONSTRAINT "storage_deletion_request_id_erasure_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."erasure_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_event_request_at" ON "erasure_event" USING btree ("request_id","at");--> statement-breakpoint
CREATE INDEX "erasure_request_academy_status" ON "erasure_request" USING btree ("academy_id","status");--> statement-breakpoint
CREATE INDEX "erasure_request_due" ON "erasure_request" USING btree ("status","execute_after");--> statement-breakpoint
CREATE UNIQUE INDEX "erasure_request_one_open" ON "erasure_request" USING btree ("academy_id","player_id") WHERE "erasure_request"."status" in ('PREVIEW_READY', 'GRACE_PERIOD', 'PROCESSING', 'BLOCKED');--> statement-breakpoint
CREATE INDEX "legal_hold_academy_open" ON "legal_hold" USING btree ("academy_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_deletion_key" ON "storage_deletion" USING btree ("academy_id","storage_key");--> statement-breakpoint
CREATE INDEX "storage_deletion_pending" ON "storage_deletion" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "access_event" ADD CONSTRAINT "access_event_category_check" CHECK ("access_event"."category" in ('WORKSPACE', 'CONSENT', 'REPORT', 'NUTRITION', 'MEDIA', 'FINANCE', 'ACCOUNT_SECURITY', 'AUDIT_LOG', 'TRAINING', 'PRIVACY'));
--> statement-breakpoint
-- The erasure history of a request is append-only: the application only ever INSERTs. (Legal holds, retention
-- rules and requests change state by UPDATE on their own rows, with every change also recorded here.)
CREATE FUNCTION erasure_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'erasure_event is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER erasure_event_no_change BEFORE UPDATE OR DELETE ON "erasure_event"
  FOR EACH ROW EXECUTE FUNCTION erasure_event_append_only();
--> statement-breakpoint
CREATE TRIGGER erasure_event_no_truncate BEFORE TRUNCATE ON "erasure_event"
  FOR EACH STATEMENT EXECUTE FUNCTION erasure_event_append_only();
