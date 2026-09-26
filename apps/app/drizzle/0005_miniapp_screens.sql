CREATE TABLE "form_draft" (
	"person_id" uuid NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_draft_person_id_shipment_id_kind_pk" PRIMARY KEY("person_id","shipment_id","kind")
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "events_seen" jsonb;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "loading_check" jsonb;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "acceptance_check" jsonb;--> statement-breakpoint
ALTER TABLE "form_draft" ADD CONSTRAINT "form_draft_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_draft" ADD CONSTRAINT "form_draft_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;