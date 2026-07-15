-- Journal d'événements de statut CDV : tenant-scopé (gabarit tenant_isolation)
-- et IMMUABLE (grants SELECT + INSERT seulement → aucune modification/suppression
-- possible par factelec_app : substrat à valeur probante, scellement en 2.2).
ALTER TABLE invoice_status_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_status_events FORCE  ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_status_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_status_events TO factelec_app;
