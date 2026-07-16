-- Balayage CROSS-TENANT des transmissions CDV `parked` (destinataire non
-- adressable/ambigu à l'émission, D6) — reprise en place (Task 7, service
-- worker/cdv-stuck-retry.service.ts), miroir EXACT find_failed_archives
-- (migration 0015) / find_stale_annuaire_drafts (migration 0020) :
-- search_path épinglé pg_catalog,pg_temp + table applicative
-- schéma-qualifiée (propriétaire BYPASSRLS : pas de shadowing possible même
-- si factelec_app obtenait un jour CREATE sur public), bornée par p_limit
-- (batch 100 côté worker, motif ArchiveRetryService.RETRY_BATCH — A5).
--
-- PAS de gate de fraîcheur temporelle ici (contrairement à
-- find_stale_annuaire_drafts, >15 min) : `parked` n'est JAMAIS un état
-- "en cours de traitement" concurrent (contrairement à un `draft`
-- potentiellement en cours de publication) — c'est un état de repos stable
-- posé synchrone par `markParked` (Task 6) à l'issue d'une tentative de
-- résolution annuaire déjà épuisée. Un rejeu immédiat est donc toujours
-- sûr (idempotence par construction de `transmitStatus`, D8).
--
-- `status_horodate` est renvoyé TEL QUEL (déjà le texte AAAAMMJJHHMMSS
-- persisté à la genèse de la ligne, colonne cdv_transmissions.status_
-- horodate) — AUCUNE reconversion depuis un timestamptz ici (à la
-- différence de find_cdv_transmissions_due, qui lit le journal SCELLÉ
-- invoice_status_events.created_at, converti côté worker — amendement A5).
CREATE OR REPLACE FUNCTION find_parked_cdv_transmissions(p_limit integer)
RETURNS TABLE (
  tenant_id uuid,
  invoice_id uuid,
  to_status public.invoice_lifecycle_status,
  target public.cdv_target,
  status_horodate text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT tenant_id, invoice_id, to_status, target, status_horodate
  FROM public.cdv_transmissions
  WHERE status = 'parked'
  ORDER BY created_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_parked_cdv_transmissions(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_parked_cdv_transmissions(integer) TO factelec_app;
