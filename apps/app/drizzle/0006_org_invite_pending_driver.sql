CREATE TABLE "org_invite" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"role" text NOT NULL,
	"token_sha256" text,
	"expires_at" timestamp with time zone,
	"invited_by_person_id" uuid,
	"expected_max_user_id" bigint,
	"requested_by_person_id" uuid,
	"accepted_person_id" uuid,
	"accepted_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "pending_shipment_id" uuid;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_invited_by_person_id_person_id_fk" FOREIGN KEY ("invited_by_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_requested_by_person_id_person_id_fk" FOREIGN KEY ("requested_by_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invite" ADD CONSTRAINT "org_invite_accepted_person_id_person_id_fk" FOREIGN KEY ("accepted_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_invite_token_uq" ON "org_invite" USING btree ("token_sha256");--> statement-breakpoint
CREATE INDEX "org_invite_org_idx" ON "org_invite" USING btree ("org_id","role");--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_pending_shipment_id_shipment_id_fk" FOREIGN KEY ("pending_shipment_id") REFERENCES "public"."shipment"("id") ON DELETE set null ON UPDATE no action;