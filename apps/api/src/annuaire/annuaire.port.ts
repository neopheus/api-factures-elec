import type { TypeFlux } from './nomenclature.js'

export const ANNUAIRE_TRANSPORT = Symbol('ANNUAIRE_TRANSPORT')

export interface PublishPayload {
  tenantId: string
  publicationRef: string
  xml: string
}
export interface PublishResult {
  trackingRef: string // sha256(xml) — déterministe (miroir Flux10, 2.3)
  location: string
}
export interface ConsultationResult {
  typeFlux: TypeFlux
  xml: string
}
export interface AnnuaireAckStatus {
  trackingRef: string
  // Acquittement PPF si connu (déposée/rejetée) — le canal local le simule
  // (`pending` par défaut) ; le canal réel l'obtiendra via le cycle de vie
  // PPF (transport différé, D1/D7). `motif` porte le motif de rejet
  // (machine à états de publication, Task 8/9).
  outcome: 'pending' | 'deposee' | 'rejetee'
  motif?: string
}

// Contrat de transport annuaire : consultation (Flux 14) + publication
// (Flux 13). Implémenté localement (dev/test) et — au déploiement — par un
// adaptateur API PISTE-OAuth2 / EDI SFTP-AS2-AS4 (auth transport, D1/D7).
export interface AnnuairePort {
  publish(payload: PublishPayload): Promise<PublishResult>
  fetchConsultation(typeFlux: TypeFlux): Promise<ConsultationResult>
  publicationStatus(trackingRef: string): Promise<AnnuaireAckStatus>
}

export class AnnuairePublishRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`publication annuaire rejetée: ${reason}`)
    this.name = 'AnnuairePublishRejectedError'
  }
}
