// Noms des jobs de la file `maintenance` (dispatchés par `job.name` dans
// worker/maintenance.processor.ts — UN SEUL @Processor(MAINTENANCE_QUEUE),
// cf. le commentaire de ce fichier pour la raison de ne jamais en créer un
// second).
export const RECONCILE_INVOICES_JOB = 'reconcile-invoices'
// PURGE_SESSIONS_JOB : purge des sessions expirées (Task 7, dette 1.4).
// Dispatché par MaintenanceProcessor (branche dédiée), planifié par
// SessionPurgeScheduler (worker/session-purge.scheduler.ts).
export const PURGE_SESSIONS_JOB = 'purge-sessions'
