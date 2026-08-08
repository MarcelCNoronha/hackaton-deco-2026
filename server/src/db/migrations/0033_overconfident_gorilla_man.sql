ALTER TABLE "generated_videos" ADD COLUMN "integrity_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generated_videos" ADD COLUMN "integrity_notes" text;