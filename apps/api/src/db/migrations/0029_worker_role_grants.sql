-- Grants de moindre privilège pour factelec_worker (Task 3, plan 3.5, D4) —
-- GRANTs SEULS, dérivés de l'inventaire réel du worker (5 processors +
-- sweeps câblés dans WorkerModule, worker-main.ts:10) : AUCUNE table,
-- colonne, ou policy nouvelle. Les policies RLS existantes sont créées SANS
-- clause TO (0001/0003/0008/0015/0017/0019/0022/0025) donc déjà TO PUBLIC —
-- elles s'appliquent automatiquement à ce nouveau rôle, `NOBYPASSRLS` (comme
-- factelec_app) le soumet à `FORCE ROW LEVEL SECURITY`. AUCUN grant sur
-- tenants/api_keys/users/platform_admins/sessions/annuaire_consents (accès
-- table refusé, contexte RLS via GUC seulement — preuve 42501 dédiée). Le
-- rôle factelec_worker est créé par scripts/db-init/00-roles.sql (dev/test)
-- et par le provisioning (prod, AVANT cette migration — item Xavier,
-- runbook Task 5, motif factelec_app).
GRANT USAGE ON SCHEMA public TO factelec_worker;
--> statement-breakpoint
-- invoices : SELECT (loadCanonical/findRoutingState/invoicesForPeriod),
-- UPDATE (markGenerationStatus/completeGeneration/bumpReconcileAttempts/
-- markArchiveStatus/markRoutingStatus) — jamais INSERT/DELETE.
GRANT SELECT, UPDATE ON invoices TO factelec_worker;
--> statement-breakpoint
-- invoice_formats : SELECT + DELETE+INSERT (completeGeneration).
GRANT SELECT, INSERT, DELETE ON invoice_formats TO factelec_worker;
--> statement-breakpoint
-- invoice_status_events : SELECT seul (loadSealedEventsByInvoice) — le
-- worker n'INSÈRE jamais, le trigger seal_status_event ne s'exécute jamais
-- côté worker.
GRANT SELECT ON invoice_status_events TO factelec_worker;
--> statement-breakpoint
-- invoice_dead_letters : INSERT seul (recordDeadLetter).
GRANT INSERT ON invoice_dead_letters TO factelec_worker;
--> statement-breakpoint
-- ereporting_declarants : SELECT seul (findDeclarant).
GRANT SELECT ON ereporting_declarants TO factelec_worker;
--> statement-breakpoint
-- ereporting_transmissions : SELECT+INSERT+UPDATE.
GRANT SELECT, INSERT, UPDATE ON ereporting_transmissions TO factelec_worker;
--> statement-breakpoint
-- ereporting_status_events : INSERT seul.
GRANT INSERT ON ereporting_status_events TO factelec_worker;
--> statement-breakpoint
-- annuaire_lignes : SELECT+UPDATE (republishDraft) — jamais INSERT.
GRANT SELECT, UPDATE ON annuaire_lignes TO factelec_worker;
--> statement-breakpoint
-- annuaire_ligne_events : INSERT seul.
GRANT INSERT ON annuaire_ligne_events TO factelec_worker;
--> statement-breakpoint
-- annuaire_directory_entries : SELECT+INSERT+UPDATE+DELETE (sync).
GRANT SELECT, INSERT, UPDATE, DELETE ON annuaire_directory_entries TO factelec_worker;
--> statement-breakpoint
-- cdv_transmissions : SELECT+INSERT+UPDATE.
GRANT SELECT, INSERT, UPDATE ON cdv_transmissions TO factelec_worker;
--> statement-breakpoint
-- cdv_transmission_events : INSERT seul.
GRANT INSERT ON cdv_transmission_events TO factelec_worker;
--> statement-breakpoint
-- payments : SELECT seul (listPaymentsForPeriod).
GRANT SELECT ON payments TO factelec_worker;
--> statement-breakpoint
-- payment_subtotals : SELECT seul (attachSubtotals).
GRANT SELECT ON payment_subtotals TO factelec_worker;
--> statement-breakpoint
-- Les 9 SEULES fonctions SD réellement appelées par le worker (JAMAIS les 8
-- SD auth/session/admin ni find_stuck_received_invoices, superseded — refus
-- EXECUTE authenticate_api_key prouvé 42501). REVOKE ALL FROM PUBLIC déjà
-- posé par chaque migration d'origine (0006/0009/0015/0017/0019/0020/0022/
-- 0023/0028) : seul le GRANT ciblé factelec_worker manque ici.
GRANT EXECUTE ON FUNCTION find_stuck_generation_invoices(integer, integer) TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_expired_sessions() TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_failed_archives(integer) TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_ereporting_declarants_due() TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_annuaire_sync_targets() TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_stale_annuaire_drafts(integer) TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_cdv_transmissions_due(timestamptz) TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_parked_cdv_transmissions(integer) TO factelec_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION find_pending_routing_invoices(integer) TO factelec_worker;
