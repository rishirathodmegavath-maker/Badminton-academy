-- RC-4: adult-controlled guardian access (DATABASE_AND_MIGRATION_DESIGN.md section 3.1; decision D5, TD-3, TD-4).
--   * guardian_access_grant: what an ADULT player has opened to one guardian (current state, one row per
--     player and guardian, tied to the guardian_link it belongs to);
--   * guardian_access_event: the append-only history of every grant, change, revocation and automatic end.
-- Additive only: no existing row or table is changed, and NO grant is created for anyone. From the release that
-- carries this migration, a guardian reads an adult player's record only through a grant made by that adult, so the
-- guardians of players who are already adults see nothing of them until the adult grants access (owner decision
-- PD-2: no back-filled, staff or guardian grants). guardian_link rows and consent history are untouched.
CREATE TABLE "guardian_access_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"guardian_user_id" text NOT NULL,
	"event" text NOT NULL,
	"scopes" jsonb,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	CONSTRAINT "guardian_access_event_type_check" CHECK ("guardian_access_event"."event" in ('ACCESS_ENDED_ADULTHOOD', 'GRANTED', 'SCOPES_CHANGED', 'REVOKED', 'ENDED_LINK_INACTIVE', 'ENDED_ADULT_FLAG_CLEARED'))
);
--> statement-breakpoint
CREATE TABLE "guardian_access_grant" (
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"guardian_user_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "guardian_access_grant_academy_id_player_id_guardian_user_id_pk" PRIMARY KEY("academy_id","player_id","guardian_user_id"),
	CONSTRAINT "guardian_access_grant_scopes_check" CHECK (jsonb_typeof("guardian_access_grant"."scopes") = 'array')
);
--> statement-breakpoint
ALTER TABLE "guardian_access_grant" ADD CONSTRAINT "guardian_access_grant_link_fkey" FOREIGN KEY ("academy_id","player_id","guardian_user_id") REFERENCES "public"."guardian_link"("academy_id","player_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guardian_access_event_player_idx" ON "guardian_access_event" USING btree ("academy_id","player_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "guardian_access_grant_lookup_idx" ON "guardian_access_grant" USING btree ("academy_id","guardian_user_id") WHERE "guardian_access_grant"."revoked_at" is null;
--> statement-breakpoint
-- The history is append-only: the application only ever INSERTs. These triggers make that a database guarantee,
-- also against direct SQL by the application's own role.
CREATE FUNCTION guardian_access_event_no_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'guardian_access_event is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER guardian_access_event_immutable BEFORE UPDATE OR DELETE ON "guardian_access_event"
  FOR EACH ROW EXECUTE FUNCTION guardian_access_event_no_change();
--> statement-breakpoint
CREATE TRIGGER guardian_access_event_no_trunc BEFORE TRUNCATE ON "guardian_access_event"
  FOR EACH STATEMENT EXECUTE FUNCTION guardian_access_event_no_change();
