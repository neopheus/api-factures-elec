export const FLUX10_TRANSMISSION = Symbol('FLUX10_TRANSMISSION')

export interface TransmitPayload {
  tenantId: string
  transmissionRef: string
  fluxKind: 'transactions' | 'payments'
  xml: string
}
export interface TransmitResult {
  trackingId: string // identifiant de suivi renvoyé par le canal
  location: string
}
export interface TransmissionStatus {
  trackingId: string
  // Acquittement PPF si connu (300/301) — le canal local le simule ; le canal
  // réel l'obtiendra via le cycle de vie PPF (transport différé, D7).
  outcome: 'pending' | 'deposee' | 'rejetee'
}
// Contrat de transmission au PPF. Implémenté localement (dev/test) et — au
// déploiement — par un adaptateur SFTP/AS2/AS4/API (auth transport, D3/D7).
export interface Flux10TransmissionPort {
  transmit(payload: TransmitPayload): Promise<TransmitResult>
  status(trackingId: string): Promise<TransmissionStatus>
}

export class TransmissionRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`transmission rejected: ${reason}`)
    this.name = 'TransmissionRejectedError'
  }
}
