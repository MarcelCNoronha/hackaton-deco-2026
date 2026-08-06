CREATE TYPE "public"."page_content_type" AS ENUM('department', 'category', 'subcategory', 'brand');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "page_content" (
	"platform" "catalog_platform" NOT NULL,
	"page_type" "page_content_type" NOT NULL,
	"scope_key" text NOT NULL,
	"seo_title" text,
	"meta_description" text,
	"keywords" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_content_platform_page_type_scope_key_pk" PRIMARY KEY("platform","page_type","scope_key")
);
