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
  ConsentSealNotFoundError,
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

// Forme canonique de la PREUVE MÉTIER SEULE — ordre FIGÉ (motif
// ledger-hash.ts:39-50). `sealedAt` en est EXCLU (F1, revue T1) : le sceau
// (sealRef, chemin) est adressé par la preuve, jamais par l'instant de
// scellement, pour que seal() soit idempotent sur la MÊME preuve d'un appel
// à l'autre — y compris à horloge différente.
function canonicalProof(payload: ConsentSealPayload): string {
  return (
    field(payload.tenantId) +
    field(payload.siren) +
    field(payload.siret) +
    field(payload.routageId) +
    field(payload.suffixe) +
    field(payload.consentType) +
    field(payload.signerIdentity) +
    field(payload.evidenceRef) +
    field(payload.obtainedAt.toISOString())
  )
}

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// Largeur FIXE (unités UTF-16 — donc aussi octets, `sealedAt` étant toujours
// ASCII) du champ longueur-préfixé encodant `sealedAt` (AAAAMMJJHHMMSS, 14
// chiffres) — dérivée du format, pas magique.
const SEALED_AT_LENGTH = 14
const SEALED_AT_FIELD_WIDTH = field('0'.repeat(SEALED_AT_LENGTH)).length

// Contenu persisté = preuve canonique (entrée du hash `sealRef`) + métadonnée
// `sealedAt` en dernier champ, longueur-préfixée mais HORS identité. Comme
// `sealedAt` est ajouté APRÈS coup et ne contient jamais de caractère
// susceptible d'apparaître à cette position, un slice depuis la FIN du
// contenu recouvre exactement les deux parties sans décodeur générique —
// valide même si un champ métier antérieur contient de l'UTF-8 multioctet
// (le slice ne touche que les derniers `SEALED_AT_FIELD_WIDTH` unités
// UTF-16, entièrement à l'intérieur du champ sealedAt).
function fileContent(canonical: string, sealedAt: string): string {
  return canonical + field(sealedAt)
}

function splitFileContent(content: string): {
  canonical: string
  sealedAt: string
} {
  return {
    canonical: content.slice(0, -SEALED_AT_FIELD_WIDTH),
    sealedAt: content.slice(-SEALED_AT_LENGTH),
  }
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
// de `seal`/`canonicalProof`), la valeur par défaut `horodateNowUtc` couvrant
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

  // WRITE-ONCE / REJEU : la clé existe déjà → on renvoie le sceau D'ORIGINE :
  // même `sealRef` (déjà connu de l'appelant — la preuve métier seule
  // l'adresse, quelle que soit l'horloge), et `sealedAt` recouvré du PREMIER
  // scellement (relu du fichier — fait constaté, jamais recalculé au rejeu).
  private async existingResult(
    path: string,
    sealRef: string,
  ): Promise<ConsentSealResult> {
    const content = await readFile(path, 'utf8')
    const { sealedAt } = splitFileContent(content)
    return { sealRef, location: path, sealedAt, alreadyExisted: true }
  }

  async seal(payload: ConsentSealPayload): Promise<ConsentSealResult> {
    const canonical = canonicalProof(payload)
    const sealRef = sha256Hex(canonical)
    const path = this.resolve(payload.tenantId, sealRef)
    const existing = await stat(path).catch(() => null)
    if (existing) return this.existingResult(path, sealRef)
    await mkdir(dirname(path), { recursive: true })
    const sealedAt = this.clock()
    const content = fileContent(canonical, sealedAt)
    try {
      // wx : échoue si la clé apparaît entre-temps (write-once fail-close).
      await writeFile(path, content, { flag: 'wx', encoding: 'utf8' })
    } catch (err) {
      // Course TOCTOU : un scellement concurrent a créé la clé entre le stat
      // et le writeFile. `wx` fail-close (aucun écrasement — l'intégrité
      // write-once tient) ; on renvoie le sceau du GAGNANT plutôt qu'une
      // erreur, pour un seal() idempotent (motif des 4 stores existants).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.existingResult(path, sealRef)
      }
      throw err
    }
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return { sealRef, location: path, sealedAt, alreadyExisted: false }
  }

  async verify(sealRef: string): Promise<ConsentSealStatus> {
    const path = await this.locate(sealRef)
    const content = await readFile(path, 'utf8')
    const { canonical } = splitFileContent(content)
    if (sha256Hex(canonical) !== sealRef) {
      throw new ConsentSignatureRejectedError(
        `intégrité rompue pour le sceau ${sealRef}`,
      )
    }
    return { sealRef, outcome: 'sealed' }
  }

  // Recherche par shard tenant : le sceau est content-addressé (`resolve`
  // n'expose pas le tenantId à partir du seul sealRef) ; baseDir contient un
  // sous-répertoire par tenant, borné en pratique (driver local dev/test —
  // le driver eIDAS réel, différé, n'a pas cette contrainte). Absence du
  // répertoire de base (aucun seal jamais écrit) → même erreur typée
  // `ConsentSealNotFoundError` qu'un sealRef inconnu, jamais une ENOENT
  // brute (F4, revue T1).
  private async locate(sealRef: string): Promise<string> {
    const fileName = `${sealRef}.seal`
    const tenantDirs = await readdir(this.baseDir).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return []
        throw err
      },
    )
    for (const tenantDir of tenantDirs) {
      const candidate = join(this.baseDir, tenantDir, fileName)
      if (await stat(candidate).catch(() => null)) return candidate
    }
    throw new ConsentSealNotFoundError(sealRef)
  }
}
