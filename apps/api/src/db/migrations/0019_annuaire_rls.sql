-- RLS FORCE + moindre privilège DIFFÉRENCIÉ sur les 4 tables annuaire
-- (gabarit tenant_isolation, cf. 0008/0015/0017) + SD cross-tenant
-- find_annuaire_sync_targets.
ALTER TABLE annuaire_consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE annuaire_consents FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON annuaire_consents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Preuve de consentement : révocation par `revoked_at` (pas de DELETE — une
-- preuve ne s'efface jamais, elle se révoque).
GRANT SELECT, INSERT, UPDATE ON annuaire_consents TO factelec_app;
--> statement-breakpoint
ALTER TABLE annuaire_lignes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE annuaire_lignes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON annuaire_lignes
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Lignes de publication : INSERT + UPDATE (statut/trackingRef/rejectReason),
-- pas de DELETE — le masquage est une transition de STATUT (update), jamais
-- une suppression de ligne.
GRANT SELECT, INSERT, UPDATE ON annuaire_lignes TO factelec_app;
--> statement-breakpoint
ALTER TABLE annuaire_ligne_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE annuaire_ligne_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON annuaire_ligne_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Journal APPEND-ONLY : SELECT + INSERT seulement (immuabilité par grants,
-- D6). PAS de trigger de hash-chain ici (contrairement à
-- invoice_status_events, migration 0012) : le journal annuaire n'est PAS
-- scellé — motif libre, aucun code de rejet réglementaire annuaire (D6).
GRANT SELECT, INSERT ON annuaire_ligne_events TO factelec_app;
--> statement-breakpoint
ALTER TABLE annuaire_directory_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE annuaire_directory_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON annuaire_directory_entries
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Miroir de consultation : régénérable par la sync (Task 9) — DELETE
-- effectivement accordé ici (contrairement aux autres tables annuaire),
-- l'usage réel (réconciliation du complet) reste hors périmètre Task 5.
GRANT SELECT, INSERT, UPDATE, DELETE ON annuaire_directory_entries TO factelec_app;
--> statement-breakpoint
-- Énumération CROSS-TENANT des tenants cibles de la sync (le worker de
-- synchronisation, Task 9, tourne hors contexte tenant — comme
-- find_ereporting_declarants_due, migration 0017). SD search_path épinglé
-- pg_catalog,pg_temp + table applicative schéma-qualifiée (propriétaire
-- BYPASSRLS : pas de shadowing possible même si factelec_app obtenait un
-- jour CREATE sur public — même motif que 0012/0015/0017). Cette fonction
-- EST appelée par l'application (Task 9) : EXECUTE accordé à factelec_app.
--
-- D8 : tous les tenants sont renvoyés (l'habilitation réelle « périmètre
-- annuaire → tenant » dépend du service d'immatriculation, différé) — la
-- sync locale peuple depuis des fixtures scopées en pré-accréditation.
CREATE OR REPLACE FUNCTION find_annuaire_sync_targets()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT id FROM public.tenants ORDER BY id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_annuaire_sync_targets() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_annuaire_sync_targets() TO factelec_app;
