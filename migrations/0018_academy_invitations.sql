CREATE TABLE "academy_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"academy_id" text NOT NULL,
	"invitee_email" text NOT NULL,
	"kind" text NOT NULL,
	"role" text NOT NULL,
	"player_id" text,
	"relationship" text,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" text,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	CONSTRAINT "academy_invitation_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "academy_invitation_email_form" CHECK ("academy_invitation"."invitee_email" = lower(btrim("academy_invitation"."invitee_email")) AND char_length("academy_invitation"."invitee_email") BETWEEN 3 AND 254),
	CONSTRAINT "academy_invitation_kind" CHECK ("academy_invitation"."kind" IN ('STAFF', 'GUARDIAN', 'ADULT_PLAYER')),
	CONSTRAINT "academy_invitation_shape" CHECK (("academy_invitation"."kind" = 'STAFF' AND "academy_invitation"."role" IN ('OWNER','ADMIN','HEAD_COACH','COACH','FINANCE','NUTRITION_PRO') AND "academy_invitation"."player_id" IS NULL AND "academy_invitation"."relationship" IS NULL)
       OR ("academy_invitation"."kind" = 'GUARDIAN' AND "academy_invitation"."role" = 'GUARDIAN' AND "academy_invitation"."player_id" IS NOT NULL AND "academy_invitation"."relationship" IS NOT NULL)
       OR ("academy_invitation"."kind" = 'ADULT_PLAYER' AND "academy_invitation"."role" = 'ADULT_PLAYER' AND "academy_invitation"."player_id" IS NULL AND "academy_invitation"."relationship" IS NULL)),
	CONSTRAINT "academy_invitation_status" CHECK ("academy_invitation"."status" IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
	CONSTRAINT "academy_invitation_state" CHECK ((("academy_invitation"."status" = 'ACCEPTED') = ("academy_invitation"."accepted_at" IS NOT NULL))
       AND (("academy_invitation"."accepted_at" IS NULL) = ("academy_invitation"."accepted_by_user_id" IS NULL))
       AND (("academy_invitation"."status" = 'REVOKED') = ("academy_invitation"."revoked_at" IS NOT NULL))
       AND (("academy_invitation"."revoked_at" IS NULL) = ("academy_invitation"."revoked_by_user_id" IS NULL))),
	CONSTRAINT "academy_invitation_expiry" CHECK ("academy_invitation"."expires_at" > "academy_invitation"."created_at")
);
--> statement-breakpoint
ALTER TABLE "academy_invitation" ADD CONSTRAINT "academy_invitation_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_invitation" ADD CONSTRAINT "academy_invitation_inviter_fk" FOREIGN KEY ("academy_id","invited_by_user_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "academy_invitation" ADD CONSTRAINT "academy_invitation_player_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academy_invitation_one_pending_person" ON "academy_invitation" USING btree ("academy_id","invitee_email") WHERE "academy_invitation"."status" = 'PENDING' AND "academy_invitation"."player_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "academy_invitation_one_pending_player" ON "academy_invitation" USING btree ("academy_id","invitee_email","player_id") WHERE "academy_invitation"."status" = 'PENDING' AND "academy_invitation"."player_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "academy_invitation_academy_idx" ON "academy_invitation" USING btree ("academy_id","status","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE FUNCTION academy_invitation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'academy_invitation rows are never deleted (the history of who invited whom is kept)' USING ERRCODE = '23514';
  END IF;
  -- ACCEPTED, REVOKED and EXPIRED are final: a used or withdrawn invitation can never be made usable again.
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'a % invitation is final and cannot change', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.id <> OLD.id OR NEW.academy_id <> OLD.academy_id OR NEW.invitee_email <> OLD.invitee_email
     OR NEW.kind <> OLD.kind OR NEW.role <> OLD.role OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.relationship IS DISTINCT FROM OLD.relationship OR NEW.token_hash <> OLD.token_hash
     OR NEW.invited_by_user_id <> OLD.invited_by_user_id OR NEW.created_at <> OLD.created_at
     OR NEW.expires_at <> OLD.expires_at THEN
    RAISE EXCEPTION 'an invitation''s academy, address, role, player, token, inviter and expiry cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER academy_invitation_guard BEFORE UPDATE OR DELETE ON academy_invitation
  FOR EACH ROW EXECUTE FUNCTION academy_invitation_guard();--> statement-breakpoint
CREATE FUNCTION academy_invitation_no_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM academy_invitation) THEN
    RAISE EXCEPTION 'academy_invitation cannot be truncated while it holds invitations' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER academy_invitation_no_truncate BEFORE TRUNCATE ON academy_invitation
  FOR EACH STATEMENT EXECUTE FUNCTION academy_invitation_no_truncate();
