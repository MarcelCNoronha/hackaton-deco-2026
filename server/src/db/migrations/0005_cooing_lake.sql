CREATE TYPE "public"."catalog_platform" AS ENUM('vtex', 'shopify');--> statement-breakpoint
ALTER TYPE "public"."provider" ADD VALUE 'shopify';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "catalog_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"platform" "catalog_platform" DEFAULT 'vtex' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "platform" "catalog_platform" DEFAULT 'vtex' NOT NULL;