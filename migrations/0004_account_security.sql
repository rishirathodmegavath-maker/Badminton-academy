CREATE TABLE "security_event" (
	"id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"academy_id" text,
	"actor_id" text,
	"target_user_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sign_in_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer NOT NULL,
	"window_started_at" timestamp NOT NULL,
	"locked_until" timestamp
);
--> statement-breakpoint
CREATE TABLE "temporary_credential" (
	"user_id" text PRIMARY KEY NOT NULL,
	"issued_by" text,
	"source" text NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "temporary_credential_expiry" CHECK ("temporary_credential"."expires_at" > "temporary_credential"."issued_at"),
	CONSTRAINT "temporary_credential_source" CHECK ("temporary_credential"."source" in ('OWNER_RESET', 'MEMBER_CREATED', 'OPERATOR_RECOVERY'))
);
--> statement-breakpoint
CREATE TABLE "totp_used_code" (
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "totp_used_code_user_id_code_hash_pk" PRIMARY KEY("user_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	CONSTRAINT "two_factor_user_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_target_user_id_app_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_credential" ADD CONSTRAINT "temporary_credential_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "temporary_credential" ADD CONSTRAINT "temporary_credential_issued_by_app_user_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_used_code" ADD CONSTRAINT "totp_used_code_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_event_academy_created" ON "security_event" USING btree ("academy_id","created_at");--> statement-breakpoint
CREATE INDEX "security_event_target_created" ON "security_event" USING btree ("target_user_id","created_at");