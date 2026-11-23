ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_id_user_unique" UNIQUE("id","user_id");--> statement-breakpoint
CREATE TABLE "auth_session_academy" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"academy_id" text NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "auth_session_academy" ADD CONSTRAINT "auth_session_academy_session_fk" FOREIGN KEY ("session_id","user_id") REFERENCES "public"."auth_session"("id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session_academy" ADD CONSTRAINT "auth_session_academy_membership_fk" FOREIGN KEY ("academy_id","user_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_session_academy_membership_idx" ON "auth_session_academy" USING btree ("academy_id","user_id");--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_display_name_length" CHECK ("membership"."display_name" IS NULL OR char_length("membership"."display_name") BETWEEN 1 AND 120);
