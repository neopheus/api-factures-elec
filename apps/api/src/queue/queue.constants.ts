// Noms des files BullMQ (partagés producteur ↔ worker).
export const INVOICE_GENERATION_QUEUE = 'invoice-generation'
export const MAINTENANCE_QUEUE = 'maintenance'
// File dédiée e-reporting Flux 10 (Task 7) : un job par (déclarant, période
// due), enfilé par le sweep (worker/ereporting-sweep.service.ts). Le
// @Processor qui la consomme arrive en Task 8 — la file est enregistrée dès
// Task 7 (WorkerQueueModule) car le PRODUCTEUR (sweep) en a besoin.
export const EREPORTING_GENERATION_QUEUE = 'ereporting-generation'
