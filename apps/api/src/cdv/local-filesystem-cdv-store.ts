import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import type {
  CdvAckStatus,
  CdvTransmissionPort,
  CdvTransmitPayload,
  CdvTransmitResult,
} from './cdv-transmission.port.js'

// Charset autorisé : la clé est dérivée de tenantId/target/invoiceId/toStatus
// (identifiants applicatifs + séparateurs sûrs) — reste défensif malgré tout
// (calque LocalFilesystemTransmissionStore 2.3 / LocalFilesystemAnnuaireStore
// 2.4).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/

function sha256Hex(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex')
}

export class InvalidCdvTransmissionKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid cdv transmission key: ${key}`)
    this.name = 'InvalidCdvTransmissionKeyError'
  }
}

export class LocalFilesystemCdvStore implements CdvTransmissionPort {
  constructor(private readonly baseDir: string) {}

  private resolve(payload: CdvTransmitPayload): string {
    const key = `${payload.tenantId}/${payload.target}/${payload.invoiceId}-${payload.toStatus}.xml`
    // Rejette traversée et chemins absolus ; normalize ne doit rien changer.
    if (!SAFE_KEY.test(key) || normalize(key) !== key || key.includes('..')) {
      throw new InvalidCdvTransmissionKeyError(key)
    }
    return join(this.baseDir, key)
  }

  // WRITE-ONCE : clé déjà présente → on renvoie le trackingRef du contenu
  // D'ORIGINE (jamais celui rejeté), sans écraser.
  private async existingResult(path: string): Promise<CdvTransmitResult> {
    const cur = await readFile(path, 'utf8')
    return { trackingRef: sha256Hex(cur), location: path }
  }

  async transmit(payload: CdvTransmitPayload): Promise<CdvTransmitResult> {
    const path = this.resolve(payload)
    const existing = await stat(path).catch(() => null)
    if (existing) return this.existingResult(path)
    await mkdir(dirname(path), { recursive: true })
    try {
      // wx : échoue si la clé apparaît entre-temps (write-once fail-close).
      await writeFile(path, payload.xml, { flag: 'wx', encoding: 'utf8' })
    } catch (err) {
      // Course TOCTOU : une transmission concurrente a créé la clé entre le
      // stat et le writeFile. `wx` fail-close (aucun écrasement — l'intégrité
      // write-once tient) ; on renvoie le trackingRef du GAGNANT plutôt
      // qu'une erreur, pour un transmit() idempotent (leçon 2.2, appliquée
      // d'emblée — cf. 2.3/2.4/Task 5).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.existingResult(path)
      }
      throw err
    }
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return { trackingRef: sha256Hex(payload.xml), location: path }
  }

  // Acquittement PPF/réseau (601 rejeté / acceptation implicite) appliqué
  // par la frontière d'acquittement (Task 8) ; le canal local n'a pas d'état
  // réel à interroger ici — `pending` par défaut, quel que soit trackingRef.
  status(trackingRef: string): Promise<CdvAckStatus> {
    return Promise.resolve({ trackingRef, outcome: 'pending' })
  }
}
