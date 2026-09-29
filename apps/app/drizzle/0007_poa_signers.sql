CREATE TABLE "poa" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"membership_id" uuid NOT NULL,
	"number" text NOT NULL,
	"internal_number" text,
	"issued_at" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"principal_inn" text NOT NULL,
	"principal_name" text,
	"rep_name" text,
	"rep_inn" text,
	"rep_snils" text,
	"source" text NOT NULL,
	"file" "bytea",
	"sig" "bytea",
	"signature_ok" boolean,
	"signed_by" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"registry_status" text DEFAULT 'unchecked' NOT NULL,
	"registry_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "membership" ADD COLUMN "signer_kind" text;--> statement-breakpoint
ALTER TABLE "poa" ADD CONSTRAINT "poa_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."membership"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poa_membership_idx" ON "poa" USING btree ("membership_id");