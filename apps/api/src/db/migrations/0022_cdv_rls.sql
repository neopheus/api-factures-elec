-- RLS FORCE + moindre privilège DIFFÉRENCIÉ sur les 2 tables de transmission
-- CDV (gabarit tenant_isolation, cf. 0008/0015/0017/0019) + SD cross-tenant
-- find_cdv_transmissions_due.
ALTER TABLE cdv_transmissions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cdv_transmissions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cdv_transmissions
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Suivi de livraison : INSERT + UPDATE (statut/trackingRef/xml/rejectReason),
-- pas de DELETE — un rejet (601) occupe légitimement le slot (D8), il ne se
-- supprime jamais.
GRANT SELECT, INSERT, UPDATE ON cdv_transmissions TO factelec_app;
--> statement-breakpoint
ALTER TABLE cdv_transmission_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE cdv_transmission_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cdv_transmission_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Journal APPEND-ONLY : SELECT + INSERT seulement (immuabilité par grants,
-- D4). PAS de trigger de hash-chain ici (contrairement à
-- invoice_status_events, migration 0012) : le journal de LIVRAISON CDV n'est
-- PAS scellé — la transmission au PPF/réseau est authentifiée au niveau
-- transport (D4).
GRANT SELECT, INSERT ON cdv_transmission_events TO factelec_app;
--> statement-breakpoint
-- Énumération CROSS-TENANT des statuts CDV facture OBLIGATOIRES dus
-- (l'ordonnanceur, Task 7, tourne hors contexte tenant — comme
-- find_ereporting_declarants_due 0017 / find_annuaire_sync_targets 0019). SD
-- search_path épinglé pg_catalog,pg_temp + table applicative
-- schéma-qualifiée (propriétaire BYPASSRLS : pas de shadowing possible même
-- si factelec_app obtenait un jour CREATE sur public — même motif que
-- 0012/0015/0017/0019) + type enum de retour schéma-qualifié
-- (public.invoice_lifecycle_status). Cette fonction EST appelée par
-- l'application (Task 7) : EXECUTE accordé à factelec_app.
--
-- LECTURE SEULE du journal SCELLÉ invoice_status_events (2.2) : cette
-- fonction ne fait qu'un SELECT ; elle ne réécrit, ne re-scelle ni ne
-- re-valide JAMAIS une ligne de ce journal (D1/D9). Seuls les 4 statuts
-- OBLIGATOIRES (§3.6.4 Tableau 8 — 200 déposée, 210 refusée, 212 encaissée,
-- 213 rejetée, D7) sont renvoyés ; les statuts FACULTATIFS (201-209, 211) ne
-- doivent PAS être transmis à l'administration fiscale et sont donc exclus
-- ici. Fenêtre BORNÉE par p_since (D8, 1ère couche anti-double-envoi) :
-- cette SD ne renvoie JAMAIS tout l'historique.
CREATE OR REPLACE FUNCTION find_cdv_transmissions_due(p_since timestamptz)
RETURNS TABLE (tenant_id uuid, invoice_id uuid, to_status public.invoice_lifecycle_status, status_created_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT e.tenant_id, e.invoice_id, e.to_status, e.created_at
  FROM public.invoice_status_events e
  WHERE e.to_status IN ('deposee', 'refusee', 'encaissee', 'rejetee')
    AND e.created_at >= p_since
  ORDER BY e.tenant_id, e.created_at
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_cdv_transmissions_due(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_cdv_transmissions_due(timestamptz) TO factelec_app;
