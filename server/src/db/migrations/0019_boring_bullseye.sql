CREATE TYPE "public"."pdp_template_level" AS ENUM('plain', 'structured', 'structured_with_image');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pdp_templates" (
	"platform" "catalog_platform" NOT NULL,
	"category" text NOT NULL,
	"level" "pdp_template_level" NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pdp_templates_platform_category_level_pk" PRIMARY KEY("platform","category","level")
);
