-- Task 3 (plan 2.1) — deux ajouts requis pour que le worker fonctionne
-- réellement sous le rôle applicatif `factelec_app` (D6 : le worker réutilise
-- ce rôle, aucun rôle dédié).

-- 1) GRANT manquant, dette Task 2 : `0001_roles_rls.sql` n'accorde que
-- SELECT/INSERT/UPDATE sur `invoice_formats` — jamais DELETE. Resté dormant
-- car Task 2 ne seedait les factures "générées" des tests de lecture qu'au
-- travers du rôle OWNER (BYPASSRLS, `seedGeneratedInvoice(ownerPool, ...)`),
-- qui contourne tout GRANT. Le worker, lui, tourne sous `factelec_app` :
-- `InvoicesRepository.completeGeneration` (ex-`saveFormats`) fait un
-- `DELETE FROM invoice_formats WHERE invoice_id = ...` avant réinsertion
-- (rejeu sûr) — sans ce GRANT, tout rejeu (retry, replay explicite) échoue en
-- 42501 (permission denied), révélé par le premier test exerçant le
-- chemin réel via `APP_POOL` (tests/e2e/invoices-repository.e2e.test.ts).
GRANT DELETE ON invoice_formats TO factelec_app;
--> statement-breakpoint

-- 2) Réconciliation (décision contrôleur, comble le trou "received" orpheline
-- documenté au commentaire InvoicesService.ingest) : si l'enfilement Redis
-- échoue APRÈS la persistance Postgres, la facture reste `received` sans
-- qu'aucun job ne référence jamais son id — aucun retry BullMQ ne peut la
-- rattraper puisqu'aucun job n'a jamais existé. Un balayage périodique (file
-- `maintenance`, cf. worker/reconciliation.scheduler.ts) doit donc pouvoir
-- lister ces factures TOUS TENANTS CONFONDUS (le worker de maintenance n'a
-- pas de contexte tenant unique — il balaie la plateforme), ce que RLS
-- interdit par construction à `factelec_app` (un seul `app.tenant_id` à la
-- fois via `SET LOCAL`, cf. `runInTenant`). Fonction SECURITY
-- DEFINER (owner, bypass RLS interne), bornée au strict nécessaire
-- (tenant_id, id) — aucun contenu de facture exposé. Même motif que
-- `authenticate_api_key` (0001) / `purge_expired_sessions` (Task 7, à venir).
CREATE OR REPLACE FUNCTION find_stuck_received_invoices(p_older_than_ms integer)
RETURNS TABLE (tenant_id uuid, id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT tenant_id, id
  FROM invoices
  WHERE status = 'received'
    AND created_at < now() - (interval '1 millisecond' * p_older_than_ms)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION find_stuck_received_invoices(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_stuck_received_invoices(integer) TO factelec_app;
