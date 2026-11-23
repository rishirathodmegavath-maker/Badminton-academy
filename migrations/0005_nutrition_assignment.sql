CREATE TABLE "nutrition_assignment" (
	"academy_id" text NOT NULL,
	"player_id" text NOT NULL,
	"professional_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"assigned_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nutrition_assignment_academy_id_player_id_professional_id_pk" PRIMARY KEY("academy_id","player_id","professional_id")
);
--> statement-breakpoint
ALTER TABLE "nutrition_assignment" ADD CONSTRAINT "nutrition_assignment_assigned_by_app_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_assignment" ADD CONSTRAINT "nutrition_assignment_academy_id_player_id_player_academy_id_id_fk" FOREIGN KEY ("academy_id","player_id") REFERENCES "public"."player"("academy_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_assignment" ADD CONSTRAINT "nutrition_assignment_academy_id_professional_id_membership_academy_id_user_id_fk" FOREIGN KEY ("academy_id","professional_id") REFERENCES "public"."membership"("academy_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nutrition_assignment_professional" ON "nutrition_assignment" USING btree ("academy_id","professional_id","active");