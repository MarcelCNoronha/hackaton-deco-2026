ALTER TYPE "public"."proposal_field" ADD VALUE 'seo_title';--> statement-breakpoint
ALTER TYPE "public"."proposal_field" ADD VALUE 'meta_description';--> statement-breakpoint
ALTER TYPE "public"."proposal_field" ADD VALUE 'keywords';--> statement-breakpoint
ALTER TYPE "public"."proposal_field" ADD VALUE 'tags';--> statement-breakpoint
ALTER TYPE "public"."proposal_field" ADD VALUE 'cta';--> statement-breakpoint
ALTER TYPE "public"."proposal_field" ADD VALUE 'attributes_patch';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "category_score_thresholds" (
	"category" text PRIMARY KEY NOT NULL,
	"excellent_min" integer DEFAULT 85 NOT NULL,
	"good_min" integer DEFAULT 60 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "seo_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "conversion_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "readability_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "structure_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "data_consistency_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "catalog_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "attributes_filled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "attributes_expected" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "questions_answered" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "content_scores" ADD COLUMN "questions_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "integrity_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_images" ADD COLUMN "integrity_notes" text;