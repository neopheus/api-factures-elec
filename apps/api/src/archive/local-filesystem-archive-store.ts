import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import {
  type ArchiveHead,
  ArchiveObjectNotFoundError,
  type ArchivePutResult,
  type ArchiveStore,
  InvalidArchiveKeyError,
} from './archive-store.port.js'

// Charset autorisé : uuid/hex + séparateurs sûrs (les clés sont construites à
// partir d'UUID et d'empreintes hex — cf. archive-bundle key).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}

export class LocalFilesystemArchiveStore implements ArchiveStore {
  constructor(private readonly baseDir: string) {}

  private resolve(key: string): string {
    // Rejette traversée et chemins absolus ; normalize ne doit rien changer.
    if (!SAFE_KEY.test(key) || normalize(key) !== key || key.includes('..')) {
      throw new InvalidArchiveKeyError(key)
    }
    return join(this.baseDir, key)
  }

  // WRITE-ONCE : clé déjà présente → on renvoie l'empreinte du contenu D'ORIGINE
  // (jamais celui rejeté), sans écraser.
  private async existingResult(path: string): Promise<ArchivePutResult> {
    const cur = await readFile(path)
    return {
      location: path,
      hash: sha256Hex(cur),
      bytes: cur.byteLength,
      alreadyExisted: true,
    }
  }

  async put(key: string, content: Buffer): Promise<ArchivePutResult> {
    const path = this.resolve(key)
    const existing = await stat(path).catch(() => null)
    if (existing) return this.existingResult(path)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, content, { flag: 'wx' }) // wx : échoue si la clé apparaît entre-temps
    } catch (err) {
      // Course TOCTOU : une écriture concurrente a créé la clé entre le stat et
      // le writeFile. `wx` a fail-close (aucun écrasement — l'intégrité
      // write-once tient) ; on renvoie l'empreinte du GAGNANT plutôt qu'une
      // erreur, pour un put() idempotent (revue T5 #1).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.existingResult(path)
      }
      throw err
    }
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return {
      location: path,
      hash: sha256Hex(content),
      bytes: content.byteLength,
      alreadyExisted: false,
    }
  }

  async head(key: string): Promise<ArchiveHead> {
    const path = this.resolve(key)
    const st = await stat(path).catch(() => null)
    if (!st) return { exists: false }
    const cur = await readFile(path)
    return { exists: true, hash: sha256Hex(cur), bytes: cur.byteLength }
  }

  async get(key: string): Promise<Buffer> {
    const path = this.resolve(key)
    const buf = await readFile(path).catch(() => null)
    if (!buf) throw new ArchiveObjectNotFoundError(key)
    return buf
  }
}
