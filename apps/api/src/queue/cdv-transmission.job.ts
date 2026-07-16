import type { CdvTarget } from '../cdv/cdv-transmission.repository.js'
import type { LifecycleStatus } from '../invoices/lifecycle-status.js'

// Nom du job posé par le sweep CDV (Task 7) sur la file `cdv-transmission` —
// UN par (facture, statut CDV FACTURE obligatoire, cible), enfilé par
// `CdvTransmissionSweepService.sweep` — jobId déterministe
// `${invoiceId}-${toStatus}-${target}` (séparateur `-`, JAMAIS `:` — leçon
// 2.4-T9, BullMQ réserve `:` aux jobId à 3 segments des anciens jobs
// répétables, `Job.validateOptions`, « Custom Id cannot contain : »).
export const CDV_TRANSMISSION_JOB = 'cdv-transmission'

// Payload MINIMAL (identifiants internes uniquement, motif 2.1/2.3/2.4 —
// AUCUN contenu de facture/F6, aucun secret) : `statusHorodate` est déjà
// formaté AAAAMMJJHHMMSS par le sweep (amendement A5 — le processor ne
// reconvertit JAMAIS un timestamptz lui-même) ; le processor
// (CdvTransmissionProcessor) recharge tout le reste depuis Postgres (RLS)
// via `CdvTransmissionService.transmitStatus` (Task 6).
export interface CdvTransmissionJob {
  tenantId: string
  invoiceId: string
  toStatus: LifecycleStatus
  target: CdvTarget
  statusHorodate: string
}
