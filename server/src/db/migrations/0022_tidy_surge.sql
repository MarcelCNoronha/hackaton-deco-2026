CREATE TYPE "public"."category_content_profile_source" AS ENUM('internal', 'references', 'manual');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "category_content_profiles" (
	"platform" "catalog_platform" NOT NULL,
	"category" text NOT NULL,
	"word_count_min" integer,
	"word_count_max" integer,
	"bullet_count" integer,
	"has_faq" boolean,
	"has_spec_table" boolean,
	"has_warranty_section" boolean,
	"source" "category_content_profile_source" DEFAULT 'manual' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_content_profiles_platform_category_pk" PRIMARY KEY("platform","category")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "category_nodes" (
	"platform" "catalog_platform" NOT NULL,
	"path" text NOT NULL,
	"vtex_category_id" text NOT NULL,
	"parent_path" text,
	"level" integer NOT NULL,
	"is_leaf" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_nodes_platform_path_pk" PRIMARY KEY("platform","path")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "category_reference_links" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"platform" "catalog_platform" NOT NULL,
	"category" text NOT NULL,
	"url" text NOT NULL,
	"extracted_signals" jsonb,
	"warning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "category_spec_fields" (
	"platform" "catalog_platform" NOT NULL,
	"category_path" text NOT NULL,
	"category_id" text NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_spec_fields_platform_category_path_pk" PRIMARY KEY("platform","category_path")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "manufacturer_reference_url" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "manufacturer_reference_facts" jsonb;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "manufacturer_reference_synced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "category_reference_links_category_idx" ON "category_reference_links" USING btree ("platform","category");