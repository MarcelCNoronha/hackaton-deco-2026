CREATE TABLE "category_prompt_rules" (
	"platform" "catalog_platform" NOT NULL,
	"category" text NOT NULL,
	"recommended_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forbidden_terms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_instructions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"image_instructions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_prompt_rules_platform_category_pk" PRIMARY KEY("platform","category")
);
