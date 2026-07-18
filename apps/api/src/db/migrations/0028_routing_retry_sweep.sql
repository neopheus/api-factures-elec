-- Sweep de reprise du routage destinataire (Task 3, plan 3.4). Miroir EXACT
-- du triptyque SD find_failed_archives (migration 0015) : cross-tenant,
-- SECURITY DEFINER read-only, search_path épinglé pg_catalog, pg_temp (PAS
-- public — même défense en profondeur que ledger_field/seal_status_event,
-- migration 0012, et find_failed_archives, migration 0015 : le propriétaire
-- est BYPASSRLS, on ne veut pas dépendre de l'absence de CREATE de
-- factelec_app sur public), table applicative schéma-qualifiée
-- (public.invoices).
--
-- Dette M1/3.3 (recipient-routing.service.ts) : `resolveAndRecord` laisse
-- `routing_status='pending'` INCHANGÉ sur erreur opérationnelle et RIEN ne
-- le rejouait avant ce sweep — le seul best-effort du projet sans reprise en
-- 3.3.
--
-- Balaie `pending` (échec opérationnel, transitoire) ET `unaddressable`
-- (retriable : une ligne d'annuaire peut entrer en vigueur plus tard, ou
-- l'acheteur être corrigé). `ambiguous` est EXCLU : ambiguïté STRUCTURELLE de
-- l'annuaire nécessitant un nettoyage opérateur — re-résoudre sans nettoyage
-- re-échouerait à l'identique (D7).
--
-- Gate de fraîcheur 15 minutes (même discipline que find_failed_archives) :
-- ne pas concurrencer une résolution fraîche en cours (à l'émission). Rotation
-- équitable : `ORDER BY updated_at` + chaque écriture de résolution
-- (markRoutingStatus, MÊME statut inchangé) bumpe `updated_at` → une facture
-- retentée-mais-toujours-en-échec repart en fin de file (anti-famine ; le
-- worker applique en plus un touch dédié à l'échec opérationnel persistant,
-- AMENDEMENT M-D7-1, cf. recipient-routing-retry.service.ts).
CREATE OR REPLACE FUNCTION find_pending_routing_invoices(p_limit integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT tenant_id, id FROM public.invoices
  WHERE status = 'generated'
    AND routing_status IN ('pending', 'unaddressable')
    AND updated_at < now() - interval '15 minutes'
  ORDER BY updated_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_pending_routing_invoices(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_pending_routing_invoices(integer) TO factelec_app;
