import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import {
  type ConsentSealPayload,
  type ConsentSealResult,
  type ConsentSealStatus,
  type ConsentSignaturePort,
  ConsentSignatureRejectedError,
} from './consent-signature.port.js'

// Charset autorisé : la clé est dérivée de tenantId/sealRef (identifiant
// applicatif + digest hex + séparateurs sûrs) — reste défensif malgré tout
// (calque LocalFilesystemCdvStore 3.1 / LocalFilesystemAnnuaireStore 2.4).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Horodate AAAAMMJJHHMMSS — UTC (motif horodateNow(), local-filesystem-annuaire-store.ts).
function horodate(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

function horodateNowUtc(): string {
  return horodate(new Date())
}

// Encodage d'un champ, longueur-préfixé (injection-proof) : NULL/undefined →
// '-1|', sinon octet_length(UTF-8)||'|'||valeur — motif ledger-hash.ts:33-36.
function field(v: string | null | undefined): string {
  if (v === null || v === undefined) return '-1|'
  return `${Buffer.byteLength(v, 'utf8')}|${v}`
}

// Forme canonique de la preuve de consentement — ordre FIGÉ (motif
// ledger-hash.ts:39-50). `sealedAt` toujours en dernier champ, longueur FIXE
// (14 caractères ASCII, AAAAMMJJHHMMSS) — invariant exploité par
// `existingResult` pour recouvrer le sealedAt d'origine sans décodeur
// générique.
function canonicalize(payload: ConsentSealPayload, sealedAt: string): string {
  return (
    field(payload.tenantId) +
    field(payload.siren) +
    field(payload.siret) +
    field(payload.routageId) +
    field(payload.suffixe) +
    field(payload.consentType) +
    field(payload.signerIdentity) +
    field(payload.evidenceRef) +
    field(payload.obtainedAt.toISOString()) +
    field(sealedAt)
  )
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class InvalidConsentKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid consent key: ${key}`)
    this.name = 'InvalidConsentKeyError'
  }
}

// Impl locale (dev/test) du scellement STRUCTUREL du consentement annuaire —
// intégrité sha256 + horodatage + write-once WORM. AUCUNE vérification
// cryptographique de signature (D1/D3) : `sealedAt` est INJECTÉ via une
// horloge fournie au constructeur (jamais `Date.now()` dans la logique pure
// de `seal`/`canonicalize`), la valeur par défaut `horodateNowUtc` couvrant
// le driver 'local' en production/dev.
export class LocalFilesystemConsentStore implements ConsentSignaturePort {
  constructor(
    private readonly baseDir: string,
    private readonly clock: () => string = horodateNowUtc,
  ) {}

  private resolve(tenantId: string, sealRef: string): string {
    const key = `${tenantId}/${sealRef}.seal`
    // Rejette traversée et chemins absolus ; normalize ne doit rien changer.
    if (!SAFE_KEY.test(key) || normalize(key) !== key || key.includes('..')) {
      throw new InvalidConsentKeyError(key)
    }
    return join(this.baseDir, key)
  }

  // WRITE-ONCE : clé déjà présente → on renvoie le sceau D'ORIGINE (jamais
  // celui de l'appel rejeté), sans écraser. `sealedAt` est recouvré depuis
  // les 14 derniers caractères du contenu canonique (dernier champ, longueur
  // fixe AAAAMMJJHHMMSS) — pas de second `Date.now()`/horloge ici.
  private async existingResult(path: string): Promise<ConsentSealResult> {
    const content = await readFile(path, 'utf8')
    return {
      sealRef: sha256Hex(content),
      location: path,
      sealedAt: content.slice(-14),
      alreadyExisted: true,
    }
  }

  async seal(payload: ConsentSealPayload): Promise<ConsentSealResult> {
    const sealedAt = this.clock()
    const canonical = canonicalize(payload, sealedAt)
    const sealRef = sha256Hex(canonical)
    const path = this.resolve(payload.tenantId, sealRef)
    const existing = await stat(path).catch(() => null)
    if (existing) return this.existingResult(path)
    await mkdir(dirname(path), { recursive: true })
    try {
      // wx : échoue si la clé apparaît entre-temps (write-once fail-close).
      await writeFile(path, canonical, { flag: 'wx', encoding: 'utf8' })
    } catch (err) {
      // Course TOCTOU : un scellement concurrent a créé la clé entre le stat
      // et le writeFile. `wx` fail-close (aucun écrasement — l'intégrité
      // write-once tient) ; on renvoie le sceau du GAGNANT plutôt qu'une
      // erreur, pour un seal() idempotent (motif des 4 stores existants).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.existingResult(path)
      }
      throw err
    }
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return { sealRef, location: path, sealedAt, alreadyExisted: false }
  }

  async verify(sealRef: string): Promise<ConsentSealStatus> {
    const path = await this.locate(sealRef)
    const content = await readFile(path, 'utf8')
    if (sha256Hex(content) !== sealRef) {
      throw new ConsentSignatureRejectedError(
        `intégrité rompue pour le sceau ${sealRef}`,
      )
    }
    return { sealRef, outcome: 'sealed' }
  }

  // Recherche par shard tenant : le sceau est content-addressé (`resolve`
  // n'expose pas le tenantId à partir du seul sealRef) ; baseDir contient un
  // sous-répertoire par tenant, borné en pratique (driver local dev/test —
  // le driver eIDAS réel, différé, n'a pas cette contrainte).
  private async locate(sealRef: string): Promise<string> {
    const fileName = `${sealRef}.seal`
    const tenantDirs = await readdir(this.baseDir)
    for (const tenantDir of tenantDirs) {
      const candidate = join(this.baseDir, tenantDir, fileName)
      if (await stat(candidate).catch(() => null)) return candidate
    }
    throw new ConsentSignatureRejectedError(`sceau introuvable : ${sealRef}`)
  }
}
