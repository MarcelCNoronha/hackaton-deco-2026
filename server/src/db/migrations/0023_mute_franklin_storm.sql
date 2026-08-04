ALTER TYPE "public"."generated_image_kind" ADD VALUE 'manufacturer_reference';--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "source_url" text;