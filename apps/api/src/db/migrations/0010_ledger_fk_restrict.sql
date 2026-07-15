-- pgcrypto n'est pas géré par drizzle (extension, hors schéma applicatif) mais
-- requis par le trigger de scellement (fonction digest(), Task 2). Extension
-- contrib standard, présente dans postgres:17-alpine (Testcontainers) ; à
-- confirmer dans les extensions managées Scaleway au déploiement (risque #1,
-- cf. plan 2.2 — n'affecte pas Task 1, DB vierge en Testcontainers).
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE "invoice_status_events" DROP CONSTRAINT "invoice_status_events_invoice_id_invoices_id_fk";
--> statement-breakpoint
ALTER TABLE "invoice_status_events" ADD CONSTRAINT "invoice_status_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;