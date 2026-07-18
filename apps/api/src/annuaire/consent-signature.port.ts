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
  // sha256(forme canonique de la PREUVE MÉTIER SEULE) — déterministe (motif
  // ledger-hash.ts). `sealedAt` N'ENTRE PAS dans ce hash (F1, revue T1) : le
  // sceau est adressé par la preuve, pas par l'instant de scellement, pour
  // que seal() soit idempotent d'un appel à l'autre sur la MÊME preuve.
  sealRef: string
  location: string
  // AAAAMMJJHHMMSS, UTC — métadonnée écrite avec le sceau, hors identité. Au
  // premier seal() : l'instant de CE scellement. Au rejeu (alreadyExisted:
  // true) : l'instant du PREMIER scellement (fait constaté, relu du fichier
  // — jamais recalculé ni celui de l'horloge de l'appel courant).
  sealedAt: string
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
//
// Contrat d'erreur de `verify` : deux causes d'échec, deux types distincts.
//   - `ConsentSealNotFoundError` : le sceau n'existe pas (sealRef inconnu,
//     ou aucun sceau jamais écrit — répertoire de base absent). Rien à
//     réconcilier, pas une atteinte à l'intégrité.
//   - `ConsentSignatureRejectedError` : le sceau existe mais le contenu ne
//     recalcule pas le sealRef fourni (altération/corruption).
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

export class ConsentSealNotFoundError extends Error {
  constructor(readonly sealRef: string) {
    super(`consent seal not found: ${sealRef}`)
    this.name = 'ConsentSealNotFoundError'
  }
}
