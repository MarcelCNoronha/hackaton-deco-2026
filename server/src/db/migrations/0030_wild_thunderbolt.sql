CREATE TABLE "generated_videos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"product_id" bigint NOT NULL,
	"source_image_url" text NOT NULL,
	"prompt" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"mime_type" text NOT NULL,
	"video_base64" text NOT NULL,
	"cost_usd" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "generated_videos" ADD CONSTRAINT "generated_videos_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generated_videos_product_id_idx" ON "generated_videos" USING btree ("product_id");