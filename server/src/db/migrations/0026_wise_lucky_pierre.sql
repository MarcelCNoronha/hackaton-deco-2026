CREATE TYPE "public"."photo_classification" AS ENUM('principal', 'ambientada', 'dimensional', 'destaque');--> statement-breakpoint
ALTER TYPE "public"."generated_image_kind" ADD VALUE 'principal' BEFORE 'lifestyle';--> statement-breakpoint
ALTER TYPE "public"."generated_image_kind" ADD VALUE 'dimensional' BEFORE 'feature_callout';--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "classification" "photo_classification";--> statement-breakpoint
-- Backfill: these two kinds always implied a fixed slot even before classification existed.
-- manufacturer_reference stays NULL — a downloaded reference photo could be any of the 4 slots,
-- so it's left for a human to classify (see products.routes.ts's classify routes).
UPDATE "generated_images" SET "classification" = 'ambientada' WHERE "kind" = 'lifestyle';--> statement-breakpoint
UPDATE "generated_images" SET "classification" = 'destaque' WHERE "kind" = 'feature_callout';