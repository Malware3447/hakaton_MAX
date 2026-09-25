ALTER TABLE "mock"."erp_shipment" ADD COLUMN "consignee_contact_name" text;--> statement-breakpoint
ALTER TABLE "mock"."erp_shipment" ADD COLUMN "consignee_phone" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "consignee_contact" jsonb;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "body_type" text;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "capacity_t" numeric;--> statement-breakpoint
ALTER TABLE "vehicle" ADD COLUMN "volume_m3" numeric;