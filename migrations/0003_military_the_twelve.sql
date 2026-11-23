ALTER TABLE "record_revision" DROP CONSTRAINT "record_revision_academy_id_entity_id_version_unique";--> statement-breakpoint
ALTER TABLE "private_media_asset" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "private_media_asset" ADD COLUMN "timestamp_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "private_media_asset" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "record_revision" ADD CONSTRAINT "record_revision_academy_id_entity_id_kind_version_unique" UNIQUE("academy_id","entity_id","kind","version");