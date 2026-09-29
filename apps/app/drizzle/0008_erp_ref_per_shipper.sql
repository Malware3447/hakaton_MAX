-- Номер отгрузки уникален в учётке отправителя, а не во всей системе (решение 29.09)
ALTER TABLE "mock"."erp_shipment" DROP CONSTRAINT "erp_shipment_pkey";--> statement-breakpoint
ALTER TABLE "mock"."erp_shipment" ADD CONSTRAINT "erp_shipment_shipper_inn_ref_pk" PRIMARY KEY("shipper_inn","ref");--> statement-breakpoint
ALTER TABLE "mock"."erp_writeback" ADD COLUMN "shipper_inn" text;--> statement-breakpoint
UPDATE "mock"."erp_writeback" w SET "shipper_inn" = e."shipper_inn" FROM "mock"."erp_shipment" e WHERE e."ref" = w."ref";
