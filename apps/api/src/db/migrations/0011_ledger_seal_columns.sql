ALTER TABLE "invoice_status_events" ADD COLUMN "seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD COLUMN "prev_hash" "bytea" DEFAULT '\x'::bytea NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD COLUMN "hash" "bytea" DEFAULT '\x'::bytea NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD CONSTRAINT "invoice_status_events_tenant_seq_unique" UNIQUE("tenant_id","seq");--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD CONSTRAINT "invoice_status_events_tenant_hash_unique" UNIQUE("tenant_id","hash");