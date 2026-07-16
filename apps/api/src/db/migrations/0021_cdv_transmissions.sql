CREATE TYPE "public"."cdv_target" AS ENUM('ppf', 'recipient');--> statement-breakpoint
CREATE TYPE "public"."cdv_transmission_status" AS ENUM('prepared', 'transmitted', 'parked', 'acknowledged', 'rejected');--> statement-breakpoint
CREATE TABLE "cdv_transmission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transmission_id" uuid NOT NULL,
	"from_status" "cdv_transmission_status",
	"to_status" "cdv_transmission_status" NOT NULL,
	"motif" text,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cdv_transmissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"to_status" "invoice_lifecycle_status" NOT NULL,
	"target" "cdv_target" NOT NULL,
	"status" "cdv_transmission_status" DEFAULT 'prepared' NOT NULL,
	"recipient_matricule" text,
	"tracking_ref" text,
	"xml" text,
	"reject_reason" text,
	"status_horodate" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cdv_transmission_events" ADD CONSTRAINT "cdv_transmission_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cdv_transmission_events" ADD CONSTRAINT "cdv_transmission_events_transmission_id_cdv_transmissions_id_fk" FOREIGN KEY ("transmission_id") REFERENCES "public"."cdv_transmissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cdv_transmissions" ADD CONSTRAINT "cdv_transmissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cdv_transmissions" ADD CONSTRAINT "cdv_transmissions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cdv_transmission_events_transmission_idx" ON "cdv_transmission_events" USING btree ("transmission_id","created_at");--> statement-breakpoint
CREATE INDEX "cdv_transmissions_tenant_idx" ON "cdv_transmissions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cdv_transmissions_invoice_status_target_unique" ON "cdv_transmissions" USING btree ("invoice_id","to_status","target");