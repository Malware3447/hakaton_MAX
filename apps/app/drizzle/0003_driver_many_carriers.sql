DROP INDEX "membership_person_role_uq";--> statement-breakpoint
DROP INDEX "shipment_active_vehicle_uq";--> statement-breakpoint
DROP INDEX "shipment_active_driver_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "membership_person_role_org_uq" ON "membership" USING btree ("person_id","role",coalesce("org_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "shipment_driver_idx" ON "shipment" USING btree ("driver_person_id");--> statement-breakpoint
CREATE INDEX "shipment_vehicle_idx" ON "shipment" USING btree ("vehicle_id");