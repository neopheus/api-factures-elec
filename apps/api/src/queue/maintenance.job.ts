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
