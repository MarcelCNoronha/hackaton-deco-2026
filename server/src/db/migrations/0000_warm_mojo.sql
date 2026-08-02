CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."metric_source" AS ENUM('gsc', 'ga4');--> statement-breakpoint
CREATE TYPE "public"."proposal_agent" AS ENUM('content', 'image');--> statement-breakpoint
CREATE TYPE "public"."proposal_field" AS ENUM('description', 'alt_text', 'structured_data', 'faq');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'edited', 'published');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('vtex', 'google', 'anthropic');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'success', 'failed', 'partial');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_request_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint,
	"provider" "provider" NOT NULL,
	"operation" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer,
	"success" boolean NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"duration_ms" integer,
	"error" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provider" "provider" NOT NULL,
	"display_name" text NOT NULL,
	"credentials_encrypted" text NOT NULL,
	"status" text DEFAULT 'untested' NOT NULL,
	"last_tested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_proposals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" bigint NOT NULL,
	"product_id" bigint NOT NULL,
	"field" "proposal_field" NOT NULL,
	"agent" "proposal_agent" NOT NULL,
	"original_value" text,
	"proposed_value" text NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"summary" jsonb,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"source" "metric_source" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"impressions" integer,
	"clicks" integer,
	"ctr" numeric,
	"avg_position" numeric,
	"sessions" integer,
	"conversion_rate" numeric,
	"revenue" numeric,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"vtex_product_id" text NOT NULL,
	"vtex_sku_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"category" text,
	"url" text,
	"embedding" vector(1536),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_request_logs" ADD CONSTRAINT "agent_request_logs_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_proposals" ADD CONSTRAINT "enrichment_proposals_run_id_enrichment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enrichment_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_proposals" ADD CONSTRAINT "enrichment_proposals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_metrics" ADD CONSTRAINT "product_metrics_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
