ALTER TABLE "enrichment_proposals" ADD COLUMN "reused_from_product_id" bigint;--> statement-breakpoint
ALTER TABLE "enrichment_proposals" ADD COLUMN "reused_similarity" numeric;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_proposals" ADD CONSTRAINT "enrichment_proposals_reused_from_product_id_products_id_fk" FOREIGN KEY ("reused_from_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
