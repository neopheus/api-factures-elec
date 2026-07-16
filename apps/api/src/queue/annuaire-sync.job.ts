import type { TypeFlux } from '../annuaire/nomenclature.js'

// Noms des jobs de la file `annuaire-sync` (Task 9) — DEUX job.name
// distincts sur la MÊME file, consommés par un SEUL @Processor
// (annuaire-sync.processor.ts qui branche par `job.name`, motif
// MaintenanceProcessor : jamais un second @Processor sur la même file) :
//  - ANNUAIRE_SYNC_JOB : ingestion F14 (posé par
//    `AnnuaireSweepService.sweepSync`, un par tenant×TypeFlux — jobId
//    déterministe `${tenantId}:${typeFlux}:${bucket}`, plan Step 1) ;
//  - ANNUAIRE_REPUBLISH_JOB : reprise d'un draft figé (posé par
//    `AnnuaireSweepService.sweepStuckDrafts`, injection revue Task 9 —
//    STUCK-DRAFT RE-PUBLISH SWEEP), un par ligne — jobId déterministe
//    `${ligneId}-republish` (PAS de `:` — BullMQ réserve les jobId à `:`
//    aux identifiants à 3 segments, compatibilité des anciens jobs
//    répétables ; cf. `Job.validateOptions`, `Custom Id cannot contain :`).
export const ANNUAIRE_SYNC_JOB = 'annuaire-sync'
export const ANNUAIRE_REPUBLISH_JOB = 'annuaire-republish'

// Payloads MINIMAUX (identifiants internes uniquement, motif 2.1/2.3 —
// AUCUN contenu du F14/F13, aucun secret) : le worker recharge tout depuis
// Postgres (RLS) et/ou le port annuaire à partir de ces identifiants.
export interface AnnuaireSyncJob {
  tenantId: string
  typeFlux: TypeFlux
}

export interface AnnuaireRepublishJob {
  tenantId: string
  ligneId: string
}
