CREATE TABLE "academy" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "auth_account_provider_id_account_id_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"version" integer NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch" (
	"id" text NOT NULL,
	"academy_id" text NOT NULL,
	"name" text NOT NULL,
	"branch_id" text NOT NULL,
	"coach_id" text NOT NULL,
	CONSTRAINT "batch_academy_id_id_pk" PRIMARY KEY("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "branch" (
	"id" text NOT NULL,
	"academy_id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "branch_academy_id_id_pk" PRIMARY KEY("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "drill_version" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"academy_id" text,
	"data" jsonb NOT NULL,
	CONSTRAINT "drill_version_id_version_pk" PRIMARY KEY("id","version")
);
--> statement-breakpoint
CREATE TABLE "favourite" (
	"academy_id" text NOT NULL,
	"user_id" text NOT NULL,
	"drill_id" text NOT NULL,
	CONSTRAINT "favourite_academy_id_user_id_drill_id_pk" PRIMARY KEY("academy_id","user_id","drill_id")
);
--> statement-breakpoint
CREATE TABLE "individual_goal" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"user_id" text NOT NULL,
	"academy_id" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "membership_academy_id_user_id_pk" PRIMARY KEY("academy_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "player" (
	"id" text NOT NULL,
	"academy_id" text NOT NULL,
	"name" text NOT NULL,
	"batch_id" text NOT NULL,
	CONSTRAINT "player_academy_id_id_pk" PRIMARY KEY("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" text NOT NULL,
	CONSTRAINT "auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session_revision" (
	"academy_id" text NOT NULL,
	"session_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "session_revision_academy_id_session_id_version_pk" PRIMARY KEY("academy_id","session_id","version")
);
--> statement-breakpoint
CREATE TABLE "auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "training_session" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"coach_id" text NOT NULL,
	"batch_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "training_session_academy_id_id_unique" UNIQUE("academy_id","id")
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_academy_id_branch_id_branch_academy_id_id_fk" FOREIGN KEY ("academy_id","branch_id") REFERENCES "public"."branch"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch" ADD CONSTRAINT "batch_academy_id_coach_id_membership_academy_id_user_id_fk" FOREIGN KEY ("academy_id","coach_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch" ADD CONSTRAINT "branch_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drill_version" ADD CONSTRAINT "drill_version_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite" ADD CONSTRAINT "favourite_academy_id_user_id_membership_academy_id_user_id_fk" FOREIGN KEY ("academy_id","user_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "individual_goal" ADD CONSTRAINT "individual_goal_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player" ADD CONSTRAINT "player_academy_id_batch_id_batch_academy_id_id_fk" FOREIGN KEY ("academy_id","batch_id") REFERENCES "public"."batch"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_revision" ADD CONSTRAINT "session_revision_academy_id_session_id_training_session_academy_id_id_fk" FOREIGN KEY ("academy_id","session_id") REFERENCES "public"."training_session"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_session" ADD CONSTRAINT "training_session_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_session" ADD CONSTRAINT "training_session_academy_id_coach_id_membership_academy_id_user_id_fk" FOREIGN KEY ("academy_id","coach_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_session" ADD CONSTRAINT "training_session_academy_id_batch_id_batch_academy_id_id_fk" FOREIGN KEY ("academy_id","batch_id") REFERENCES "public"."batch"("academy_id","id") ON DELETE no action ON UPDATE no action;