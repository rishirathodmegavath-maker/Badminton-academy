CREATE TABLE "consent_event" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"category" text NOT NULL,
	"sequence" integer NOT NULL,
	"decision" text NOT NULL,
	"policy_version_id" text,
	"actor_id" text,
	"actor_role" text,
	"authority" text,
	"method" text NOT NULL,
	"evidence_ref" text,
	"reason" text,
	"effective_at" timestamp,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"previous_event_id" text,
	"previous_decision" text,
	CONSTRAINT "consent_event_sequence" UNIQUE("academy_id","player_id","subject_user_id","category","sequence"),
	CONSTRAINT "consent_event_category_check" CHECK ("consent_event"."category" in ('PORTAL', 'EMAIL', 'WHATSAPP')),
	CONSTRAINT "consent_event_decision_check" CHECK ("consent_event"."decision" in ('GRANTED', 'RENEWED', 'WITHDRAWN', 'LAPSED')),
	CONSTRAINT "consent_event_method_check" CHECK ("consent_event"."method" in ('PORTAL_SELF', 'STAFF_WRITTEN', 'STAFF_VERBAL', 'IMPORT_LEGACY', 'SYSTEM_POLICY')),
	CONSTRAINT "consent_event_sequence_check" CHECK ("consent_event"."sequence" >= 1),
	CONSTRAINT "consent_event_evidence_check" CHECK ("consent_event"."method" not in ('STAFF_WRITTEN', 'STAFF_VERBAL') or "consent_event"."decision" not in ('GRANTED', 'RENEWED') or length(trim(coalesce("consent_event"."evidence_ref", ''))) > 0),
	CONSTRAINT "consent_event_legacy_check" CHECK ("consent_event"."method" <> 'IMPORT_LEGACY' or ("consent_event"."actor_id" is null and "consent_event"."policy_version_id" is null and "consent_event"."decision" = 'GRANTED')),
	CONSTRAINT "consent_event_system_check" CHECK (("consent_event"."method" = 'SYSTEM_POLICY') = ("consent_event"."decision" = 'LAPSED'))
);
--> statement-breakpoint
CREATE TABLE "consent_policy_version" (
	"id" text PRIMARY KEY NOT NULL,
	"academy_id" text NOT NULL,
	"category" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"require_renewal" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"published_by" text,
	"published_at" timestamp,
	"effective_at" timestamp,
	CONSTRAINT "consent_policy_version_number" UNIQUE("academy_id","category","version"),
	CONSTRAINT "consent_policy_version_ref" UNIQUE("academy_id","id","category"),
	CONSTRAINT "consent_policy_version_status_check" CHECK ("consent_policy_version"."status" in ('DRAFT', 'PUBLISHED')),
	CONSTRAINT "consent_policy_version_category_check" CHECK ("consent_policy_version"."category" in ('PORTAL', 'EMAIL', 'WHATSAPP')),
	CONSTRAINT "consent_policy_version_published_check" CHECK (("consent_policy_version"."status" = 'DRAFT' and "consent_policy_version"."published_at" is null) or ("consent_policy_version"."status" = 'PUBLISHED' and "consent_policy_version"."published_at" is not null and "consent_policy_version"."effective_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_actor_id_app_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_academy_id_player_id_subject_user_id_guardian_link_academy_id_player_id_user_id_fk" FOREIGN KEY ("academy_id","player_id","subject_user_id") REFERENCES "public"."guardian_link"("academy_id","player_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_event" ADD CONSTRAINT "consent_event_academy_id_policy_version_id_category_consent_policy_version_academy_id_id_category_fk" FOREIGN KEY ("academy_id","policy_version_id","category") REFERENCES "public"."consent_policy_version"("academy_id","id","category") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_policy_version" ADD CONSTRAINT "consent_policy_version_academy_id_academy_id_fk" FOREIGN KEY ("academy_id") REFERENCES "public"."academy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_policy_version" ADD CONSTRAINT "consent_policy_version_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_policy_version" ADD CONSTRAINT "consent_policy_version_published_by_app_user_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_event_player_recorded" ON "consent_event" USING btree ("academy_id","player_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_policy_version_one_draft" ON "consent_policy_version" USING btree ("academy_id","category") WHERE "consent_policy_version"."status" = 'DRAFT';
--> statement-breakpoint
-- Consent history is append-only: the application only ever INSERTs. These triggers make that a database
-- guarantee (also against direct SQL by the application's own role). Phase 8 (erasure) must decide how
-- to handle deletion of a person's history deliberately; it is not possible by accident.
CREATE FUNCTION consent_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_event is append-only: % is not permitted', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER consent_event_no_change BEFORE UPDATE OR DELETE ON "consent_event"
  FOR EACH ROW EXECUTE FUNCTION consent_event_append_only();
--> statement-breakpoint
-- A published consent version is frozen: its text, number and category can never change and it can never
-- be deleted. A draft may be edited and then published (the one allowed transition), never changed back.
CREATE FUNCTION consent_policy_version_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'PUBLISHED' THEN
      RAISE EXCEPTION 'A published consent version cannot be deleted' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION 'A published consent version cannot be changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.academy_id <> OLD.academy_id OR NEW.category <> OLD.category OR NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'The identity of a consent version cannot change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER consent_policy_version_frozen BEFORE UPDATE OR DELETE ON "consent_policy_version"
  FOR EACH ROW EXECUTE FUNCTION consent_policy_version_guard();
--> statement-breakpoint
-- Existing consent flags become ONE explicitly-marked legacy GRANTED event each (true flags only). Nothing is
-- invented: no actor, no document version, no effective date (those were never recorded); recorded_at is the
-- time of this migration. Flags that are false produce no event (we cannot tell "never asked" from
-- "withdrawn"). The flags themselves are untouched, so no message is gained or lost by upgrading.
INSERT INTO "consent_event" ("id", "academy_id", "player_id", "subject_user_id", "category", "sequence", "decision", "method", "evidence_ref", "authority", "recorded_at")
SELECT gen_random_uuid()::text, l."academy_id", l."player_id", l."user_id", c."category", 1, 'GRANTED', 'IMPORT_LEGACY',
       'Consent flag that existed before history was recorded; who recorded it, when, and on which document were not recorded.',
       l."relationship", (now() AT TIME ZONE 'utc')
FROM "guardian_link" l
CROSS JOIN (VALUES ('PORTAL', 'portal'), ('EMAIL', 'email'), ('WHATSAPP', 'whatsapp')) AS c("category", "key")
WHERE (l."consent" ->> c."key") = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM "consent_event" e
    WHERE e."academy_id" = l."academy_id" AND e."player_id" = l."player_id"
      AND e."subject_user_id" = l."user_id" AND e."category" = c."category"
  );
