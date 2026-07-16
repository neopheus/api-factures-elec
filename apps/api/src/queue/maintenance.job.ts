// Noms des jobs de la file `maintenance` (dispatchés par `job.name` dans
// worker/maintenance.processor.ts — UN SEUL @Processor(MAINTENANCE_QUEUE),
// cf. le commentaire de ce fichier pour la raison de ne jamais en créer un
// second).
export const RECONCILE_INVOICES_JOB = 'reconcile-invoices'
// PURGE_SESSIONS_JOB : purge des sessions expirées (Task 7, dette 1.4).
// Dispatché par MaintenanceProcessor (branche dédiée), planifié par
// SessionPurgeScheduler (worker/session-purge.scheduler.ts).
export const PURGE_SESSIONS_JOB = 'purge-sessions'
// ARCHIVE_RETRY_JOB : reprise d'archivage best-effort (Task 8) — rejoue
// `archiveInvoice` sur les factures dont l'archivage a échoué (ou est resté
// figé en `pending`). Dispatché par MaintenanceProcessor (branche dédiée),
// planifié par ArchiveRetryScheduler (worker/archive-retry.scheduler.ts).
export const ARCHIVE_RETRY_JOB = 'archive-retry'
// EREPORTING_SWEEP_JOB : ordonnanceur e-reporting Flux 10 (plan 2.3, Task 7)
// — énumère les déclarants actifs (find_ereporting_declarants_due, SD
// cross-tenant) puis enfile un job `ereporting-generation` par période due
// (period.ts, fenêtre bornée). Dispatché par MaintenanceProcessor (branche
// dédiée), planifié par EreportingScheduler
// (worker/ereporting.scheduler.ts).
export const EREPORTING_SWEEP_JOB = 'ereporting-sweep'
// ANNUAIRE_SYNC_DIFF_JOB / ANNUAIRE_SYNC_FULL_JOB : ordonnanceur de
// synchronisation annuaire (plan 2.4, Task 9) — différentiel ~quotidien
// (TypeFlux='D', upsert seul) / complet ~hebdomadaire (TypeFlux='C',
// remplacement — A-SYNC-RECONCILE). Chacun énumère les tenants cibles (SD
// `find_annuaire_sync_targets`, migration 0019) puis enfile un job
// `annuaire-sync` par tenant (worker/annuaire-sweep.service.ts,
// `AnnuaireSweepService.sweepSync`). Dispatchés par MaintenanceProcessor
// (branches dédiées), planifiés par AnnuaireScheduler
// (worker/annuaire.scheduler.ts).
export const ANNUAIRE_SYNC_DIFF_JOB = 'annuaire-sync-diff'
export const ANNUAIRE_SYNC_FULL_JOB = 'annuaire-sync-full'
// ANNUAIRE_REPUBLISH_SWEEP_JOB : sweep de reprise des drafts figés (Task 9,
// injection revue contrôleur STUCK-DRAFT RE-PUBLISH SWEEP — fix du défaut T8
// F1) — énumère les lignes 'draft' figées depuis >15 min (SD
// `find_stale_annuaire_drafts`, migration 0020) puis enfile un job
// `annuaire-republish` par ligne (`AnnuaireSweepService.sweepStuckDrafts`).
// Dispatché par MaintenanceProcessor (branche dédiée), planifié par
// AnnuaireScheduler.
export const ANNUAIRE_REPUBLISH_SWEEP_JOB = 'annuaire-republish-sweep'
// CDV_TRANSMISSION_SWEEP_JOB : ordonnanceur borné 24h de transmission CDV
// (plan 3.1, Task 7) — énumère les statuts CDV FACTURE obligatoires dus
// (find_cdv_transmissions_due, SD cross-tenant, migration 0022, fenêtre
// bornée `dueSince`, cdv-deadline.ts/amendement A5) puis enfile un job
// `cdv-transmission` par (facture, statut, cible)
// (worker/cdv-transmission-sweep.service.ts,
// `CdvTransmissionSweepService.sweep`). Dispatché par MaintenanceProcessor
// (branche dédiée), planifié par CdvTransmissionScheduler
// (worker/cdv-transmission.scheduler.ts).
export const CDV_TRANSMISSION_SWEEP_JOB = 'cdv-transmission-sweep'
// CDV_STUCK_RETRY_JOB : reprise des transmissions CDV `parked` (Task 7,
// amendement A5 — batch borné, miroir ArchiveRetryService.sweepFailedArchives)
// — énumère les lignes `parked` tous tenants confondus
// (find_parked_cdv_transmissions, SD cross-tenant, migration 0023) puis
// rejoue DIRECTEMENT `CdvTransmissionService.transmitStatus` par ligne
// (worker/cdv-stuck-retry.service.ts, `CdvStuckRetryService.retryParked` —
// PAS d'enfilement, contrairement à CDV_TRANSMISSION_SWEEP_JOB ci-dessus :
// la reprise est idempotente par construction, motif ArchiveRetryService,
// PAS AnnuaireSweepService.sweepStuckDrafts). Dispatché par
// MaintenanceProcessor (branche dédiée), planifié par
// CdvTransmissionScheduler.
export const CDV_STUCK_RETRY_JOB = 'cdv-stuck-retry'
