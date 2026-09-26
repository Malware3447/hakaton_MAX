CREATE TABLE "org_lookup_cache" (
	"inn" text PRIMARY KEY NOT NULL,
	"found" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
