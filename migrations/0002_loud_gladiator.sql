CREATE TABLE "academy_settings" (
	"academy_id" text PRIMARY KEY NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_event" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'SCHEDULED' NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "calendar_event_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "private_conversation" (
	"id" text PRIMARY KEY NOT NULL,
	"player_id" text NOT NULL,
	"academy_id" text NOT NULL,
	"guardian_id" text NOT NULL,
	"subject" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"entries" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"message_id" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_delivery_academy_id_message_id_user_id_channel_unique" UNIQUE("academy_id","message_id","user_id","channel")
);
--> statement-breakpoint
CREATE TABLE "admission_enquiry" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ENQUIRY' NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "admission_enquiry_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "feature_entitlement" (
	"academy_id" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"name" text NOT NULL,
	"amount" integer NOT NULL,
	"currency" text NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	CONSTRAINT "fee_plan_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "guardian_link" (
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"user_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"relationship" text NOT NULL,
	"consent" jsonb NOT NULL,
	CONSTRAINT "guardian_link_academy_id_player_id_user_id_pk" PRIMARY KEY("academy_id","player_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "invoice" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ISSUED' NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "invoice_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "lesson_credit" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"units" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_credit_academy_id_idempotency_key_unique" UNIQUE("academy_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "private_media_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'PRIVATE' NOT NULL,
	"feedback" text DEFAULT '' NOT NULL,
	"reviewer_id" text,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_template" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"name" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"academy_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "message_draft_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "nutrition_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "nutrition_plan_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "nutrition_question" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"author_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observation_review" (
	"academy_id" text NOT NULL,
	"session_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"approved_text" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "observation_review_academy_id_session_id_observation_id_pk" PRIMARY KEY("academy_id","session_id","observation_id")
);
--> statement-breakpoint
CREATE TABLE "payment_reference" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reference" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "payment_reference_academy_id_id_unique" UNIQUE("academy_id","id"),
	CONSTRAINT "payment_reference_academy_id_idempotency_key_unique" UNIQUE("academy_id","idempotency_key"),
	CONSTRAINT "payment_reference_academy_id_reference_unique" UNIQUE("academy_id","reference")
);
--> statement-breakpoint
CREATE TABLE "player_history" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"kind" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_profile" (
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "player_profile_academy_id_player_id_pk" PRIMARY KEY("academy_id","player_id")
);
--> statement-breakpoint
CREATE TABLE "record_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "record_revision_academy_id_entity_id_version_unique" UNIQUE("academy_id","entity_id","version")
);
--> statement-breakpoint
CREATE TABLE "payment_refund" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"payment_id" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refund_academy_id_idempotency_key_unique" UNIQUE("academy_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "player_report" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "player_report_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "restricted_nutrition" (
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"allergies" text NOT NULL,
	"restrictions" text NOT NULL,
	CONSTRAINT "restricted_nutrition_academy_id_player_id_pk" PRIMARY KEY("academy_id","player_id")
);
--> statement-breakpoint
ALTER TABLE "academy_settings" ADD CONSTRAINT "academy_settings_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event" ADD CONSTRAINT "calendar_event_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_conversation" ADD CONSTRAINT "private_conversation_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_conversation" ADD CONSTRAINT "private_conversation_guardian_id_app_user_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_delivery" ADD CONSTRAINT "outbox_delivery_academy_id_message_id_message_draft_academy_id_id_fk" FOREIGN KEY ("academy_id","message_id") REFERENCES "public"."message_draft"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admission_enquiry" ADD CONSTRAINT "admission_enquiry_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_entitlement" ADD CONSTRAINT "feature_entitlement_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_plan" ADD CONSTRAINT "fee_plan_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_link" ADD CONSTRAINT "guardian_link_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardian_link" ADD CONSTRAINT "guardian_link_academy_id_user_id_membership_academy_id_user_id_fk" FOREIGN KEY ("academy_id","user_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson_credit" ADD CONSTRAINT "lesson_credit_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_asset" ADD CONSTRAINT "private_media_asset_owner_id_app_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_media_asset" ADD CONSTRAINT "private_media_asset_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_template" ADD CONSTRAINT "message_template_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_draft" ADD CONSTRAINT "message_draft_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_draft" ADD CONSTRAINT "message_draft_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_plan" ADD CONSTRAINT "nutrition_plan_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_question" ADD CONSTRAINT "nutrition_question_author_id_app_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_question" ADD CONSTRAINT "nutrition_question_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_review" ADD CONSTRAINT "observation_review_reviewer_id_app_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_review" ADD CONSTRAINT "observation_review_academy_id_session_id_training_session_academy_id_id_fk" FOREIGN KEY ("academy_id","session_id") REFERENCES "public"."training_session"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reference" ADD CONSTRAINT "payment_reference_academy_id_invoice_id_invoice_academy_id_id_fk" FOREIGN KEY ("academy_id","invoice_id") REFERENCES "public"."invoice"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_history" ADD CONSTRAINT "player_history_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_profile" ADD CONSTRAINT "player_profile_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_revision" ADD CONSTRAINT "record_revision_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refund" ADD CONSTRAINT "payment_refund_academy_id_payment_id_payment_reference_academy_id_id_fk" FOREIGN KEY ("academy_id","payment_id") REFERENCES "public"."payment_reference"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_report" ADD CONSTRAINT "player_report_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restricted_nutrition" ADD CONSTRAINT "restricted_nutrition_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;