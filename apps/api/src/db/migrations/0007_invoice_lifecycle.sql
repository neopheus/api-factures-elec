CREATE TYPE "public"."invoice_lifecycle_status" AS ENUM('deposee', 'emise', 'recue', 'mise_a_disposition', 'prise_en_charge', 'approuvee', 'approuvee_partiellement', 'en_litige', 'suspendue', 'completee', 'refusee', 'paiement_transmis', 'encaissee', 'rejetee');--> statement-breakpoint
CREATE TABLE "invoice_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"from_status" "invoice_lifecycle_status",
	"to_status" "invoice_lifecycle_status" NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "lifecycle_status" "invoice_lifecycle_status" DEFAULT 'deposee' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD CONSTRAINT "invoice_status_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD CONSTRAINT "invoice_status_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_status_events_invoice_idx" ON "invoice_status_events" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "invoice_status_events_tenant_idx" ON "invoice_status_events" USING btree ("tenant_id");