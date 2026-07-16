export interface CasStaleErrorInput {
  entity: string
  id: string
  expectedStatus: string
  message: string
}

// Erreur commune aux 7 sites CAS des repos (cdv/annuaire/ereporting, D8) :
// remplace les 3 CAS_STALE_RE textuels divergents par une détection par
// type. Le message reste celui produit par le repository (super), conservé
// pour les logs — seule la détection en amont passe du texte au type.
export class CasStaleError extends Error {
  readonly entity: string
  readonly id: string
  readonly expectedStatus: string

  constructor({ entity, id, expectedStatus, message }: CasStaleErrorInput) {
    super(message)
    this.name = 'CasStaleError'
    this.entity = entity
    this.id = id
    this.expectedStatus = expectedStatus
  }
}
