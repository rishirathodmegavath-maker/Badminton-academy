CREATE TABLE "auth_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"recipient_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"sealed_payload" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"provider_message_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_email_outbox_kind_check" CHECK ("auth_email_outbox"."kind" in ('EMAIL_VERIFICATION_OTP', 'PASSWORD_RESET_LINK')),
	CONSTRAINT "auth_email_outbox_status_check" CHECK ("auth_email_outbox"."status" in ('PENDING', 'SENDING', 'SENT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')),
	CONSTRAINT "auth_email_outbox_attempts_check" CHECK ("auth_email_outbox"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "email_verification_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_email_outbox_idempotency_key_idx" ON "auth_email_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "auth_email_outbox_dispatch_idx" ON "auth_email_outbox" USING btree ("next_attempt_at","created_at") WHERE "auth_email_outbox"."status" in ('PENDING', 'FAILED_RETRYABLE');--> statement-breakpoint
CREATE INDEX "auth_email_outbox_user_idx" ON "auth_email_outbox" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_account_user_provider_idx" ON "auth_account" USING btree ("user_id","provider_id");--> statement-breakpoint
CREATE INDEX "auth_session_user_idx" ON "auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification" USING btree ("identifier");
