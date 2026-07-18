export const CONSENT_SIGNATURE = Symbol('CONSENT_SIGNATURE')

export interface ConsentSealPayload {
  tenantId: string
  siren: string
  siret?: string
  routageId?: string
  suffixe?: string
  consentType: string
  signerIdentity: string
  evidenceRef: string
  obtainedAt: Date
}

export interface ConsentSealResult {
  sealRef: string // sha256(forme canonique) — déterministe (motif ledger-hash.ts)
  location: string
  sealedAt: string // AAAAMMJJHHMMSS, UTC
  alreadyExisted: boolean
}

export interface ConsentSealStatus {
  sealRef: string
  outcome: 'sealed'
}

// Contrat de scellement STRUCTUREL (intégrité sha256 + horodatage + write-once
// WORM) de la preuve de consentement annuaire déclarée par le client — AUCUNE
// vérification cryptographique de signature, AUCUNE valeur probante ni
// qualification juridique (D1/D3, posture d'honnêteté : la doc dit exactement
// ce que le scellement fait). Implémenté localement (dev/test) et — au
// déploiement — par un fournisseur eIDAS réel (signature qualifiée, driver
// différé, D1/D3).
export interface ConsentSignaturePort {
  seal(payload: ConsentSealPayload): Promise<ConsentSealResult>
  verify(sealRef: string): Promise<ConsentSealStatus>
}

export class ConsentSignatureRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`consent signature rejected: ${reason}`)
    this.name = 'ConsentSignatureRejectedError'
  }
}
