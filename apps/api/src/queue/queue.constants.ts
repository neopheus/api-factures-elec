// Noms des files BullMQ (partagés producteur ↔ worker).
export const INVOICE_GENERATION_QUEUE = 'invoice-generation'
export const MAINTENANCE_QUEUE = 'maintenance'
// File dédiée e-reporting Flux 10 (Task 7) : un job par (déclarant, période
// due), enfilé par le sweep (worker/ereporting-sweep.service.ts). Le
// @Processor qui la consomme arrive en Task 8 — la file est enregistrée dès
// Task 7 (WorkerQueueModule) car le PRODUCTEUR (sweep) en a besoin.
export const EREPORTING_GENERATION_QUEUE = 'ereporting-generation'
// File dédiée annuaire (Task 9, plan 2.4) : DEUX job.name distincts, UN seul
// @Processor (annuaire-sync.processor.ts, motif MaintenanceProcessor) —
// ANNUAIRE_SYNC_JOB (ingestion F14, un par tenant×TypeFlux, posé par
// AnnuaireSweepService.sweepSync) et ANNUAIRE_REPUBLISH_JOB (reprise de
// draft figé, un par ligne, posé par AnnuaireSweepService.sweepStuckDrafts —
// injection revue Task 9, fix du défaut T8 F1).
export const ANNUAIRE_SYNC_QUEUE = 'annuaire-sync'
// File dédiée CDV Flux 6 (Task 7, plan 3.1) : un job par (facture, statut
// obligatoire, cible), enfilé par le sweep
// (worker/cdv-transmission-sweep.service.ts, `CdvTransmissionSweepService.
// sweep`) et consommé par `CdvTransmissionProcessor` (`@Processor`, Task 7 —
// PAS une tâche différée comme EREPORTING_GENERATION_QUEUE, Task 7/8 : le
// producteur ET le consommateur sont livrés dans la MÊME tâche ici).
export const CDV_TRANSMISSION_QUEUE = 'cdv-transmission'
