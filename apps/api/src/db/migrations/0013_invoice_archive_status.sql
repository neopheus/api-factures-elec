CREATE TYPE "public"."archive_status" AS ENUM('pending', 'archived', 'failed');--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "archive_status" "archive_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "archive_location" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "archive_hash" text;