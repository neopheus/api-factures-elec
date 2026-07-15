-- RLS FORCE + moindre privilège DIFFÉRENCIÉ sur les 3 tables e-reporting
-- (gabarit tenant_isolation, cf. 0008/0015) + SD cross-tenant find_ereporting_declarants_due.
ALTER TABLE ereporting_declarants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ereporting_declarants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ereporting_declarants
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Config opérateur : mutable (SELECT/INSERT/UPDATE/DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON ereporting_declarants TO factelec_app;
--> statement-breakpoint
ALTER TABLE ereporting_transmissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ereporting_transmissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ereporting_transmissions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Transmissions : INSERT + UPDATE (statut/tracking/xml), pas de DELETE.
GRANT SELECT, INSERT, UPDATE ON ereporting_transmissions TO factelec_app;
--> statement-breakpoint
ALTER TABLE ereporting_status_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ereporting_status_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ereporting_status_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Journal APPEND-ONLY : SELECT + INSERT seulement (immuabilité par grants,
-- D3/D5). PAS de trigger de hash-chain ici (contrairement à
-- invoice_status_events, migration 0012) : le journal e-reporting n'est PAS
-- scellé — la transmission au PPF est authentifiée au niveau transport.
GRANT SELECT, INSERT ON ereporting_status_events TO factelec_app;
--> statement-breakpoint
-- Énumération CROSS-TENANT des déclarants actifs (l'ordonnanceur, Task 7,
-- tourne hors contexte tenant — comme find_failed_archives, migration 0015).
-- SD search_path épinglé pg_catalog,pg_temp + table applicative
-- schéma-qualifiée (propriétaire BYPASSRLS : pas de shadowing possible même
-- si factelec_app obtenait un jour CREATE sur public — même motif que
-- 0012/0015) + types enum de retour schéma-qualifiés. Contrairement au
-- trigger 2.2 (ledger_field/seal_status_event), cette fonction EST appelée
-- par l'application (Task 7) : EXECUTE accordé à factelec_app.
--
-- Note de calcul de la « dueness » : cette fonction renvoie ICI tous les
-- déclarants actifs ; c'est l'ordonnanceur (Task 7, period.ts) qui calcule,
-- PAR RÉGIME, les périodes échues à l'instant `now`. La sélection des
-- échéances reste HORS SQL (module pur, unit-testable) — interprétation
-- projet (D4).
CREATE OR REPLACE FUNCTION find_ereporting_declarants_due()
RETURNS TABLE (tenant_id uuid, id uuid, vat_regime public.ereporting_vat_regime, role public.ereporting_issuer_role, siren text, name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT tenant_id, id, vat_regime, role, siren, name
  FROM public.ereporting_declarants
  WHERE active = true
  ORDER BY tenant_id, id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_ereporting_declarants_due() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_ereporting_declarants_due() TO factelec_app;
