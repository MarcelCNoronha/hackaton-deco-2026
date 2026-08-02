CREATE TYPE "public"."llm_provider" AS ENUM('anthropic', 'openai', 'gemini');--> statement-breakpoint
CREATE TYPE "public"."llm_task" AS ENUM('contentEnrichment', 'imageAltText', 'evaluator');--> statement-breakpoint
ALTER TYPE "public"."provider" ADD VALUE 'openai';--> statement-breakpoint
ALTER TYPE "public"."provider" ADD VALUE 'gemini';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_routing" (
	"task" "llm_task" PRIMARY KEY NOT NULL,
	"provider" "llm_provider" NOT NULL,
	"model" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
