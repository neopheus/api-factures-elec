import type { FluxKind } from '../ereporting/ereporting.repository.js'
import type {
  IssuerRole,
  TransmissionType,
} from '../ereporting/nomenclature.js'

// Nom du job posé par le sweep e-reporting (Task 7) sur la file
// `ereporting-generation` — le @Processor qui le consomme arrive en Task 8.
export const EREPORTING_GENERATE_JOB = 'ereporting-generate'

// Payload MINIMAL : uniquement des identifiants internes (aucun contenu de
// facture/transaction, aucun secret — motif 2.1, cf. InvoiceGenerationJob).
// Le worker (Task 8) recharge tout depuis Postgres sous RLS
// (invoicesForPeriod) à partir de `siren`/`role`/`periodStart`/`periodEnd`.
export interface EreportingGenerationJob {
  tenantId: string
  declarantId: string
  siren: string
  role: IssuerRole
  fluxKind: FluxKind
  periodStart: string
  periodEnd: string
  type: TransmissionType
  // Discriminant du rectificatif (plan 3.4, D3) : nombre de RE déjà committés
  // pour ce slot, lu à l'enfilement (countRetransmissions, Task 2) — OMIS par
  // le sweep pour un IN (payload minimal préservé). Traverse tel quel
  // jusqu'à buildTransmissionRef (ignoré si type='IN').
  reSeq?: number
}
