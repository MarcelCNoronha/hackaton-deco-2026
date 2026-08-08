ALTER TABLE "category_nodes" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "page_content" ADD COLUMN "page_url" text;--> statement-breakpoint
ALTER TABLE "page_content" ADD COLUMN "first_published_at" timestamp with time zone;