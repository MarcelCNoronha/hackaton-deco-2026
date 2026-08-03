CREATE TYPE "public"."generated_image_kind" AS ENUM('lifestyle', 'feature_callout');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "generated_images" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"kind" "generated_image_kind" NOT NULL,
	"prompt" text NOT NULL,
	"mime_type" text NOT NULL,
	"image_base64" text NOT NULL,
	"cost_usd" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "generated_images" ADD CONSTRAINT "generated_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generated_images_product_id_idx" ON "generated_images" USING btree ("product_id");