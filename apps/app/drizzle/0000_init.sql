CREATE SCHEMA "mock";
--> statement-breakpoint
CREATE TABLE "card" (
	"shipment_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"mid" text NOT NULL,
	"render_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_shipment_id_person_id_pk" PRIMARY KEY("shipment_id","person_id")
);
--> statement-breakpoint
CREATE TABLE "dialog" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"step" text NOT NULL,
	"shipment_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"shipment_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_person_id" uuid,
	"actor_role" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox" (
	"key" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"org_id" uuid,
	"is_admin" boolean DEFAULT false NOT NULL,
	"can_sign" boolean DEFAULT false NOT NULL,
	"poa_number" text,
	"poa_valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_message" (
	"person_id" uuid PRIMARY KEY NOT NULL,
	"mid" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock"."epd_document" (
	"operator_doc_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"uid" text,
	"reject_code" text,
	"reject_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mock"."epd_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock"."epd_title" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"operator_doc_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"xml" "bytea" NOT NULL,
	"signatures" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock"."erp_shipment" (
	"ref" text PRIMARY KEY NOT NULL,
	"shipper_inn" text NOT NULL,
	"consignee_inn" text NOT NULL,
	"consignee_name" text NOT NULL,
	"loading_address" text NOT NULL,
	"unloading_address" text NOT NULL,
	"planned_loading_at" timestamp with time zone,
	"lines" jsonb NOT NULL,
	"places" integer NOT NULL,
	"gross_kg" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock"."erp_writeback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ref" text NOT NULL,
	"status" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mock"."org_registry" (
	"inn" text PRIMARY KEY NOT NULL,
	"kpp" text,
	"name" text NOT NULL,
	"address" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"inn" text NOT NULL,
	"kpp" text,
	"name" text NOT NULL,
	"address" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"erp_kind" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"role" text NOT NULL,
	"person_id" uuid,
	"invite_token_sha256" text,
	"invite_expires_at" timestamp with time zone,
	"invite_single_use" boolean DEFAULT false NOT NULL,
	"expected_max_user_id" bigint,
	"expected_phone_sha256" text,
	"identity_mismatch" boolean DEFAULT false NOT NULL,
	"invited_by_person_id" uuid,
	"source" text,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_invite_token_sha256_unique" UNIQUE("invite_token_sha256")
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"max_user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"phone_sha256" text,
	"consent_at" timestamp with time zone,
	"active_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_max_user_id_unique" UNIQUE("max_user_id")
);
--> statement-breakpoint
CREATE TABLE "shipment" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"erp_ref" text NOT NULL,
	"shipper_org_id" uuid NOT NULL,
	"carrier_org_id" uuid,
	"consignee_org_id" uuid NOT NULL,
	"loading_address" text NOT NULL,
	"unloading_address" text NOT NULL,
	"planned_loading_at" timestamp with time zone,
	"cargo" jsonb NOT NULL,
	"vehicle_id" uuid,
	"driver_person_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"turn" text,
	"turn_since" timestamp with time zone DEFAULT now() NOT NULL,
	"loading_remarks" text,
	"acceptance" jsonb,
	"uid" text,
	"operator_doc_id" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signature" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"title_kind" text NOT NULL,
	"title_id" uuid,
	"role" text NOT NULL,
	"kind" text NOT NULL,
	"signer_person_id" uuid NOT NULL,
	"cms" "bytea",
	"signer_name" text,
	"signer_snils" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verify_result" text,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "title" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"shipment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"id_file" text NOT NULL,
	"xml" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"streebog" text,
	"prev_title_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"plate" text NOT NULL,
	"brand" text NOT NULL,
	"ownership" text NOT NULL,
	"owner_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card" ADD CONSTRAINT "card_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialog" ADD CONSTRAINT "dialog_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialog" ADD CONSTRAINT "dialog_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_message" ADD CONSTRAINT "menu_message_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock"."epd_title" ADD CONSTRAINT "epd_title_operator_doc_id_epd_document_operator_doc_id_fk" FOREIGN KEY ("operator_doc_id") REFERENCES "mock"."epd_document"("operator_doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_invited_by_person_id_person_id_fk" FOREIGN KEY ("invited_by_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_shipper_org_id_org_id_fk" FOREIGN KEY ("shipper_org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_carrier_org_id_org_id_fk" FOREIGN KEY ("carrier_org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_consignee_org_id_org_id_fk" FOREIGN KEY ("consignee_org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_vehicle_id_vehicle_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicle"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_driver_person_id_person_id_fk" FOREIGN KEY ("driver_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_title_id_title_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."title"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signature" ADD CONSTRAINT "signature_signer_person_id_person_id_fk" FOREIGN KEY ("signer_person_id") REFERENCES "public"."person"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title" ADD CONSTRAINT "title_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_shipment_at_idx" ON "event" USING btree ("shipment_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_person_role_uq" ON "membership" USING btree ("person_id","role");--> statement-breakpoint
CREATE INDEX "membership_org_idx" ON "membership" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_inn_uq" ON "org" USING btree ("inn");--> statement-breakpoint
CREATE UNIQUE INDEX "participant_shipment_role_uq" ON "participant" USING btree ("shipment_id","role");--> statement-breakpoint
CREATE INDEX "participant_person_idx" ON "participant" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_erp_ref_uq" ON "shipment" USING btree ("shipper_org_id","erp_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_active_vehicle_uq" ON "shipment" USING btree ("vehicle_id") WHERE state not in ('draft', 'closed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "shipment_active_driver_uq" ON "shipment" USING btree ("driver_person_id") WHERE state not in ('draft', 'closed', 'cancelled');--> statement-breakpoint
CREATE INDEX "shipment_turn_idx" ON "shipment" USING btree ("turn","turn_since");--> statement-breakpoint
CREATE INDEX "signature_shipment_idx" ON "signature" USING btree ("shipment_id","title_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "title_shipment_kind_uq" ON "title" USING btree ("shipment_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_org_plate_uq" ON "vehicle" USING btree ("org_id","plate");