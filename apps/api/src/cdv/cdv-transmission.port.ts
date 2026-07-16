import type { LifecycleStatus } from '../invoices/lifecycle-status.js'

export const CDV_TRANSMISSION = Symbol('CDV_TRANSMISSION')

export interface CdvTransmitPayload {
  tenantId: string
  invoiceId: string
  // Statut CDV FACTURE transmis (200/210/212/213, D7) — PAS le statut de la
  // machine de LIVRAISON (cf. cdv-transmission-lifecycle.ts, Task 3).
  toStatus: LifecycleStatus
  // Cible (D7) : PPF (réglementaire, toujours adressable) ou plateforme de
  // réception (résolue par l'annuaire 2.4, D6). Littéral dupliqué à dessein
  // (miroir Flux10TransmissionPort/`fluxKind`, 2.3) : le port ne dépend pas
  // du repository (Task 4/`CdvTarget`), qui est un niveau d'orchestration
  // au-dessus.
  target: 'ppf' | 'recipient'
  xml: string
}
export interface CdvTransmitResult {
  trackingRef: string // sha256(xml) — déterministe (miroir Flux10 2.3 / annuaire 2.4)
  location: string
}
export interface CdvAckStatus {
  trackingRef: string
  // Acquittement PPF/réseau si connu (601 rejeté explicite ⊕ acceptation
  // implicite) — le canal local le simule (`pending` par défaut) ; le canal
  // réel l'obtiendra via le cycle de vie PPF/réseau (transport différé,
  // D1/D7). `motif` porte le motif de rejet (MDT-126, machine de livraison
  // Task 3, frontière d'acquittement Task 8).
  outcome: 'pending' | 'acknowledged' | 'rejected'
  motif?: string
}

// Contrat de transmission du Flux 6 (message CDV, format CDAR) vers le PPF
// et la plateforme de réception. Implémenté localement (dev/test) et — au
// déploiement — par un adaptateur SFTP/AS2/AS4 X.509/AS4-Peppol/API OAuth2
// (auth transport, D1/D7).
export interface CdvTransmissionPort {
  transmit(payload: CdvTransmitPayload): Promise<CdvTransmitResult>
  status(trackingRef: string): Promise<CdvAckStatus>
}

export class CdvTransmissionRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`cdv transmission rejected: ${reason}`)
    this.name = 'CdvTransmissionRejectedError'
  }
}
