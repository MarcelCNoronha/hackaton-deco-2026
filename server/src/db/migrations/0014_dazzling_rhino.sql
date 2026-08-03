CREATE INDEX IF NOT EXISTS "agent_request_logs_run_id_idx" ON "agent_request_logs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_scores_run_id_idx" ON "content_scores" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_proposals_run_id_idx" ON "enrichment_proposals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_proposals_product_id_idx" ON "enrichment_proposals" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_proposals_status_idx" ON "enrichment_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_metrics_product_id_idx" ON "product_metrics" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_vtex_product_id_idx" ON "products" USING btree ("vtex_product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" USING btree ("user_id");