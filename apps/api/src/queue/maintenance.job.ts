// Noms des jobs de la file `maintenance` (dispatchés par `job.name` dans
// worker/maintenance.processor.ts — UN SEUL @Processor(MAINTENANCE_QUEUE),
// cf. le commentaire de ce fichier pour la raison de ne jamais en créer un
// second).
export const RECONCILE_INVOICES_JOB = 'reconcile-invoices'
// PURGE_SESSIONS_JOB : ajouté par Task 7 (purge des sessions expirées) —
// AJOUTER une branche à MaintenanceProcessor.process, ne pas créer un second
// @Processor sur la même file.
