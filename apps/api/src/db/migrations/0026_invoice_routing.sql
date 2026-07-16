CREATE TYPE "public"."routing_status" AS ENUM('pending', 'resolved', 'unaddressable', 'ambiguous');--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "routing_status" "routing_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recipient_platform" text;