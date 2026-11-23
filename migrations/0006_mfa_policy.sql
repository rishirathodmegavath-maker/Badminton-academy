CREATE TABLE "academy_mfa_policy" (
	"academy_id" text PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warn_since" timestamp,
	"updated_by" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "academy_mfa_policy_mode_check" CHECK ("academy_mfa_policy"."mode" in ('off', 'warn', 'enforce'))
);
--> statement-breakpoint
ALTER TABLE "academy_mfa_policy" ADD CONSTRAINT "academy_mfa_policy_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_mfa_policy" ADD CONSTRAINT "academy_mfa_policy_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;