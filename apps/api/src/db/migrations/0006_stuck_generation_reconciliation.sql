-- Task 3 (fix post-revue, plan 2.1) — le filet de réconciliation ne
-- couvrait que les factures bloquées en `received` (enfilement Redis en
-- échec après persistance). Trou identifié en revue : si l'écriture finale
-- du statut `failed` se perd dans la course décrite au rapport Task 3
-- (`@OnWorkerEvent('failed')` non attendu par `Worker.close()`), une
-- facture peut rester bloquée en `generating` INDÉFINIMENT — le job BullMQ
-- sous-jacent est pourtant bien épuisé (`failed`), mais rien ne balayait ce
-- cas. On étend la fonction SECURITY DEFINER pour couvrir les DEUX statuts
-- bloquants, avec un seuil dédié PAR statut (`received` : enfilement
-- manqué, seuil court ; `generating` : génération/traitement du résultat
-- interrompu, seuil plus large — une génération légitime ne dure jamais
-- 15 minutes). Renommée en conséquence (`find_stuck_generation_invoices`).
DROP FUNCTION IF EXISTS find_stuck_received_invoices(integer);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION find_stuck_generation_invoices(
  p_received_older_than_ms integer,
  p_generating_older_than_ms integer
)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT tenant_id, id
  FROM invoices
  WHERE (
      status = 'received'
      AND created_at < now() - (interval '1 millisecond' * p_received_older_than_ms)
    )
     OR (
      status = 'generating'
      AND updated_at < now() - (interval '1 millisecond' * p_generating_older_than_ms)
    )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_stuck_generation_invoices(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_stuck_generation_invoices(integer, integer) TO factelec_app;
