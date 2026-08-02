CREATE TYPE "public"."score_target" AS ENUM('original', 'proposed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "content_scores" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"target" "score_target" NOT NULL,
	"checklist_score" integer NOT NULL,
	"buyer_confidence" integer NOT NULL,
	"buyer_unanswered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"geo_answerable_count" integer NOT NULL,
	"geo_total_questions" integer NOT NULL,
	"unsupported_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overall_score" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_scores" ADD CONSTRAINT "content_scores_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "content_scores" ADD CONSTRAINT "content_scores_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
