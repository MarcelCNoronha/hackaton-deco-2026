CREATE TABLE IF NOT EXISTS "provider_free_quotas" (
	"provider" "llm_provider" PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"quota_usd" numeric DEFAULT '0' NOT NULL,
	"reset_interval_hours" integer DEFAULT 24 NOT NULL,
	"period_start_at" timestamp with time zone DEFAULT now() NOT NULL
);
