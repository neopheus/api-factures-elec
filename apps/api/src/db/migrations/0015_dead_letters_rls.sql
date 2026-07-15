-- DLQ tenant-scopée + append-only (SELECT/INSERT seulement, comme le journal).
ALTER TABLE invoice_dead_letters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invoice_dead_letters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invoice_dead_letters
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT ON invoice_dead_letters TO factelec_app;
--> statement-breakpoint
-- Balayage cross-tenant des archives en échec (reprise d'archivage). Même
-- triptyque SD que find_stuck_generation_invoices (migration 0006).
--
-- Amendement contrôleur D1 (défense en profondeur) : search_path épinglé à
-- pg_catalog, pg_temp (PAS public) et table applicative schéma-qualifiée
-- (public.invoices). Le propriétaire (factelec_owner) est BYPASSRLS ; laisser
-- search_path=public exposerait cette fonction SECURITY DEFINER à un
-- shadowing d'objet (escalade) si factelec_app obtenait un jour CREATE sur
-- public — on ne veut pas en dépendre (même motif que ledger_field/
-- seal_status_event, migration 0012).
--
-- Amendement revue T6 finding #3 : balaie AUSSI les `pending` STALE (> 15
-- min). Fenêtre rare de double-échec DB : store.put() réussit mais le
-- markArchiveStatus('archived') qui suit ÉCHOUE, et le catch de secours
-- markArchiveStatus('failed') échoue LUI AUSSI (ArchiveService.archiveInvoice)
-- → le bundle est déjà écrit sur disque mais `archive_status` reste figé à
-- `pending` indéfiniment, sans jamais être réconcilié. Le seuil de 15 minutes
-- évite de concurrencer un archivage frais en cours (une facture normale
-- archive en quelques secondes dans son propre job) ; passé ce délai, un
-- `pending` est authentiquement bloqué. `archiveInvoice` est idempotent
-- (head() détecte le bundle existant → re-marque `archived` sans réécrire).
CREATE OR REPLACE FUNCTION find_failed_archives(p_limit integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
STABLE
AS $$
  SELECT tenant_id, id FROM public.invoices
  WHERE status = 'generated'
    AND (archive_status = 'failed'
         OR (archive_status = 'pending' AND updated_at < now() - interval '15 minutes'))
  ORDER BY updated_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_failed_archives(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_failed_archives(integer) TO factelec_app;
