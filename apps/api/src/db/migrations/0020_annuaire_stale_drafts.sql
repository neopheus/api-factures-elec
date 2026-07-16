-- Sweep de reprise des drafts figés (Task 9, injection revue contrôleur
-- STUCK-DRAFT RE-PUBLISH SWEEP — fix du défaut T8 F1) : un crash entre
-- `port.publish` et `markPublished` laisse une ligne en 'draft' avec le F13
-- déjà émis — rien ne la récupère et elle occupe indéfiniment le slot
-- d'adressage (A-DEADLOCK). SD cross-tenant, miroir EXACT de
-- find_failed_archives (migration 0015) : search_path épinglé
-- pg_catalog,pg_temp + table applicative schéma-qualifiée (propriétaire
-- BYPASSRLS : pas de shadowing possible), bornée par p_limit, gate de
-- fraîcheur 15 minutes (même discipline que archive_status='pending').
-- Le worker (Task 9, AnnuaireSweepService.sweepStuckDrafts) appelle cette
-- fonction hors contexte tenant, PUIS enfile un job `annuaire-republish` par
-- ligne (jobId déterministe `${ligneId}-republish`) — jamais un rejeu direct
-- ici (cette fonction ne fait qu'énumérer, motif find_failed_archives).
CREATE OR REPLACE FUNCTION find_stale_annuaire_drafts(p_limit integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT tenant_id, id FROM public.annuaire_lignes
  WHERE status = 'draft'
    AND created_at < now() - interval '15 minutes'
  ORDER BY created_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_stale_annuaire_drafts(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_stale_annuaire_drafts(integer) TO factelec_app;
