CREATE TABLE "contact_point" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text,
	"user_id" text,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"label" text,
	"opted_in_at" timestamp with time zone,
	"opt_in_source" text,
	"opt_in_recorded_by" text,
	"opt_in_revoked_at" timestamp with time zone,
	"suppressed_at" timestamp with time zone,
	"suppression_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_point_one_subject" CHECK ((("player_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int) = 1),
	CONSTRAINT "contact_point_channel" CHECK ("channel" IN ('EMAIL', 'WHATSAPP')),
	CONSTRAINT "contact_point_address_form" CHECK (("channel" = 'EMAIL' AND "address" = lower(btrim("address")) AND "address" ~ '^[^@[:space:]]+@[^@[:space:]]+$' AND char_length("address") <= 254) OR ("channel" = 'WHATSAPP' AND "address" ~ '^[+][1-9][0-9]{7,14}$')),
	CONSTRAINT "contact_point_opt_in_source" CHECK ("opt_in_source" IS NULL OR "opt_in_source" IN ('INVITATION_ACCEPT', 'OWNER_WRITTEN', 'OWNER_VERBAL', 'PARENT_FORM')),
	CONSTRAINT "contact_point_opt_in_pair" CHECK (("opted_in_at" IS NULL) = ("opt_in_source" IS NULL)),
	CONSTRAINT "contact_point_opt_in_whatsapp_only" CHECK ("opted_in_at" IS NULL OR "channel" = 'WHATSAPP'),
	CONSTRAINT "contact_point_suppression_pair" CHECK (("suppressed_at" IS NULL) = ("suppression_reason" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_player_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_point" ADD CONSTRAINT "contact_point_member_fk" FOREIGN KEY ("academy_id","user_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_point_subject_address" ON "contact_point" USING btree ("academy_id",coalesce("player_id", ''),coalesce("user_id", ''),"channel","address");--> statement-breakpoint
CREATE INDEX "contact_point_lookup_idx" ON "contact_point" USING btree ("academy_id","channel","address");--> statement-breakpoint
CREATE TABLE "report_policy" (
	"academy_id" text PRIMARY KEY NOT NULL,
	"monthly_enabled" boolean DEFAULT false NOT NULL,
	"sessions_enabled" boolean DEFAULT false NOT NULL,
	"sessions_n" integer DEFAULT 8 NOT NULL,
	"required_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_policy_sessions_n" CHECK ("sessions_n" BETWEEN 2 AND 60),
	CONSTRAINT "report_policy_categories" CHECK (jsonb_typeof("required_categories") = 'array')
);
--> statement-breakpoint
ALTER TABLE "report_policy" ADD CONSTRAINT "report_policy_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "dispatch_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"kind" text DEFAULT 'REPORT' NOT NULL,
	"title" text NOT NULL,
	"recipient_mode" text NOT NULL,
	"consolidation" text DEFAULT 'PER_PARENT' NOT NULL,
	"channels" jsonb NOT NULL,
	"report_ids" jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "dispatch_batch_kind" CHECK ("kind" IN ('REPORT')),
	CONSTRAINT "dispatch_batch_mode" CHECK ("recipient_mode" IN ('PARENTS', 'PLAYERS', 'BOTH')),
	CONSTRAINT "dispatch_batch_consolidation" CHECK ("consolidation" IN ('PER_PARENT', 'PER_CHILD')),
	CONSTRAINT "dispatch_batch_status" CHECK ("status" IN ('DRAFT', 'APPROVED', 'CANCELLED')),
	CONSTRAINT "dispatch_batch_approval_pair" CHECK (("approved_at" IS NULL) = ("approved_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "dispatch_batch" ADD CONSTRAINT "dispatch_batch_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_batch" ADD CONSTRAINT "dispatch_batch_academy_id_unique" UNIQUE ("academy_id","id");--> statement-breakpoint
CREATE INDEX "dispatch_batch_academy_idx" ON "dispatch_batch" USING btree ("academy_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE TABLE "dispatch_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"address_hash" text NOT NULL,
	"recipient_names" jsonb NOT NULL,
	"subject_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report_ids" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"skip_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"leased_by" text,
	"provider_message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "dispatch_item_channel" CHECK ("channel" IN ('EMAIL', 'WHATSAPP')),
	CONSTRAINT "dispatch_item_status" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED_RETRYABLE', 'FAILED', 'SKIPPED', 'CANCELLED')),
	CONSTRAINT "dispatch_item_skip_reason" CHECK (("status" = 'SKIPPED') = ("skip_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "dispatch_item" ADD CONSTRAINT "dispatch_item_batch_fk" FOREIGN KEY ("academy_id","batch_id") REFERENCES "public"."dispatch_batch"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_item" ADD CONSTRAINT "dispatch_item_academy_id_unique" UNIQUE ("academy_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_item_one_per_address" ON "dispatch_item" USING btree ("batch_id","channel","address_hash");--> statement-breakpoint
CREATE INDEX "dispatch_item_due_idx" ON "dispatch_item" USING btree ("next_attempt_at") WHERE "dispatch_item"."status" IN ('QUEUED', 'FAILED_RETRYABLE');--> statement-breakpoint
CREATE INDEX "dispatch_item_lease_idx" ON "dispatch_item" USING btree ("lease_until") WHERE "dispatch_item"."status" = 'SENDING';--> statement-breakpoint
CREATE INDEX "dispatch_item_batch_idx" ON "dispatch_item" USING btree ("batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_item_provider_message" ON "dispatch_item" USING btree ("channel","provider_message_id") WHERE "dispatch_item"."provider_message_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "dispatch_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispatch_event_type" CHECK ("type" IN ('ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BOUNCED', 'COMPLAINED', 'STOP'))
);
--> statement-breakpoint
ALTER TABLE "dispatch_event" ADD CONSTRAINT "dispatch_event_item_fk" FOREIGN KEY ("academy_id","item_id") REFERENCES "public"."dispatch_item"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_event_once" ON "dispatch_event" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "dispatch_event_item_idx" ON "dispatch_event" USING btree ("item_id","occurred_at");--> statement-breakpoint
CREATE TABLE "report_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"item_id" uuid NOT NULL,
	"report_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"first_opened_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_link" ADD CONSTRAINT "report_link_item_fk" FOREIGN KEY ("academy_id","item_id") REFERENCES "public"."dispatch_item"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_link" ADD CONSTRAINT "report_link_report_fk" FOREIGN KEY ("academy_id","report_id") REFERENCES "public"."player_report"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_link_one_per_item_report" ON "report_link" USING btree ("item_id","report_id");--> statement-breakpoint
CREATE INDEX "report_link_report_idx" ON "report_link" USING btree ("academy_id","report_id");--> statement-breakpoint
ALTER TABLE "observation_review" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "observation_review" ADD CONSTRAINT "observation_review_category" CHECK ("category" IS NULL OR "category" IN ('TECHNICAL', 'TACTICAL', 'PHYSICAL', 'BEHAVIOUR'));
