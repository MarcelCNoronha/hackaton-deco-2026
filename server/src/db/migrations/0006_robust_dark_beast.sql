CREATE TABLE IF NOT EXISTS "provider_spend_limits" (
	"provider" "llm_provider" PRIMARY KEY NOT NULL,
	"limit_usd" numeric NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
