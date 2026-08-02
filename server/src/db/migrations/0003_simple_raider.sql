ALTER TABLE "agent_request_logs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "agent_request_logs" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_request_logs" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "agent_request_logs" ADD COLUMN "cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "agent_request_logs" ADD COLUMN "product_id" bigint;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_request_logs" ADD CONSTRAINT "agent_request_logs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
