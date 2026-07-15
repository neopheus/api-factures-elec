export const ARCHIVE_STORE = Symbol('ARCHIVE_STORE')

export interface ArchivePutResult {
  location: string
  hash: string // sha256 hex du contenu
  bytes: number
  alreadyExisted: boolean // write-once : true si la clé existait déjà (pas d'écrasement)
}

export interface ArchiveHead {
  exists: boolean
  hash?: string
  bytes?: number
}

// Contrat WORM : put est write-once (ne JAMAIS écraser une clé existante).
// Implémenté localement (dev/test) et — au déploiement — par un adaptateur S3
// object-lock COMPLIANCE (voir D5). Signatures identiques → substituable par env.
export interface ArchiveStore {
  put(key: string, content: Buffer): Promise<ArchivePutResult>
  head(key: string): Promise<ArchiveHead>
  get(key: string): Promise<Buffer>
}

export class ArchiveObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`archive object not found: ${key}`)
    this.name = 'ArchiveObjectNotFoundError'
  }
}
export class InvalidArchiveKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid archive key: ${key}`)
    this.name = 'InvalidArchiveKeyError'
  }
}
