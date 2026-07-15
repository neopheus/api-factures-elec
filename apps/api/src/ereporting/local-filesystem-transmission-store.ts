import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import type {
  Flux10TransmissionPort,
  TransmissionStatus,
  TransmitPayload,
  TransmitResult,
} from './flux10-transmission.port.js'

// Charset autorisé : la clé est dérivée de tenantId/fluxKind/transmissionRef
// (identifiants applicatifs + séparateurs sûrs) — reste défensif malgré tout
// (calque LocalFilesystemArchiveStore, 2.2).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/

function sha256Hex(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex')
}

export class InvalidTransmissionKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid transmission key: ${key}`)
    this.name = 'InvalidTransmissionKeyError'
  }
}

export class LocalFilesystemTransmissionStore
  implements Flux10TransmissionPort
{
  constructor(private readonly baseDir: string) {}

  private resolve(payload: TransmitPayload): string {
    const key = `${payload.tenantId}/${payload.fluxKind}/${payload.transmissionRef}.xml`
    // Rejette traversée et chemins absolus ; normalize ne doit rien changer.
    if (!SAFE_KEY.test(key) || normalize(key) !== key || key.includes('..')) {
      throw new InvalidTransmissionKeyError(key)
    }
    return join(this.baseDir, key)
  }

  // WRITE-ONCE : clé déjà présente → on renvoie le trackingId du contenu
  // D'ORIGINE (jamais celui rejeté), sans écraser.
  private async existingResult(path: string): Promise<TransmitResult> {
    const cur = await readFile(path, 'utf8')
    return { trackingId: sha256Hex(cur), location: path }
  }

  async transmit(payload: TransmitPayload): Promise<TransmitResult> {
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
      // write-once tient) ; on renvoie le trackingId du GAGNANT plutôt qu'une
      // erreur, pour un transmit() idempotent (leçon 2.2, revue T5 #1 —
      // appliquée d'emblée, pas réintroduite comme défaut).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.existingResult(path)
      }
      throw err
    }
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return { trackingId: sha256Hex(payload.xml), location: path }
  }

  // Acquittement PPF (300/301) appliqué par Task 9 (cycle de vie e-reporting) ;
  // le canal local n'a pas d'état PPF réel à interroger ici — `pending` par
  // défaut, quel que soit trackingId.
  status(trackingId: string): Promise<TransmissionStatus> {
    return Promise.resolve({ trackingId, outcome: 'pending' })
  }
}
