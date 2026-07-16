import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { create } from 'xmlbuilder2'
import type {
  AnnuaireAckStatus,
  AnnuairePort,
  ConsultationResult,
  PublishPayload,
  PublishResult,
} from './annuaire.port.js'
import type { TypeFlux } from './nomenclature.js'

// Charset autorisé : la clé est dérivée de tenantId/publicationRef
// (identifiants applicatifs + séparateurs sûrs) — reste défensif malgré tout
// (calque LocalFilesystemTransmissionStore, 2.3 / LocalFilesystemArchiveStore,
// 2.2).
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.:-]*$/

function sha256Hex(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex')
}

export class InvalidPublicationKeyError extends Error {
  constructor(readonly key: string) {
    super(`invalid publication key: ${key}`)
    this.name = 'InvalidPublicationKeyError'
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Horodate AAAAMMJJHHMMSS (HorodateType, Annuaire_Commun.xsd) — UTC, format
// vérifié contre HORODATE_RE (nomenclature.ts).
function horodateNow(): string {
  const d = new Date()
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

// F14 « vide » XSD-valide (HorodateProduction + TypeFlux seuls,
// BlocLignesAnnuaire — et les 3 autres blocs, tous optionnels — absents,
// D8 PII-minimale) : sert de fixture par défaut tant qu'aucun fichier
// `f14-<typeFlux>.xml` n'a été déposé (sync réelle F14, Task 9).
function emptyConsultationXml(typeFlux: TypeFlux): string {
  const doc = create({ version: '1.0', encoding: 'UTF-8' })
  doc
    .ele('AnnuaireConsultationF14')
    .ele('HorodateProduction')
    .txt(horodateNow())
    .up()
    .ele('TypeFlux')
    .txt(typeFlux)
  return doc.end({ prettyPrint: true })
}

export class LocalFilesystemAnnuaireStore implements AnnuairePort {
  constructor(private readonly baseDir: string) {}

  private resolvePublication(payload: PublishPayload): string {
    const key = `${payload.tenantId}/${payload.publicationRef}.xml`
    // Rejette traversée et chemins absolus ; normalize ne doit rien changer.
    if (!SAFE_KEY.test(key) || normalize(key) !== key || key.includes('..')) {
      throw new InvalidPublicationKeyError(key)
    }
    return join(this.baseDir, key)
  }

  // WRITE-ONCE : clé déjà présente → on renvoie le trackingRef du contenu
  // D'ORIGINE (jamais celui rejeté), sans écraser.
  private async existingResult(path: string): Promise<PublishResult> {
    const cur = await readFile(path, 'utf8')
    return { trackingRef: sha256Hex(cur), location: path }
  }

  async publish(payload: PublishPayload): Promise<PublishResult> {
    const path = this.resolvePublication(payload)
    const existing = await stat(path).catch(() => null)
    if (existing) return this.existingResult(path)
    await mkdir(dirname(path), { recursive: true })
    try {
      // wx : échoue si la clé apparaît entre-temps (write-once fail-close).
      await writeFile(path, payload.xml, { flag: 'wx', encoding: 'utf8' })
    } catch (err) {
      // Course TOCTOU : une publication concurrente a créé la clé entre le
      // stat et le writeFile. `wx` fail-close (aucun écrasement — l'intégrité
      // write-once tient) ; on renvoie le trackingRef du GAGNANT plutôt
      // qu'une erreur, pour un publish() idempotent (leçon 2.2, appliquée
      // d'emblée — cf. 2.3/Task 6).
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.existingResult(path)
      }
      throw err
    }
    await chmod(path, 0o444) // lecture seule (immuabilité locale, simulacre WORM)
    return { trackingRef: sha256Hex(payload.xml), location: path }
  }

  // Consultation Flux 14 : sert un fixture déterministe s'il a été déposé
  // (sync réelle, Task 9), sinon un F14 vide XSD-valide (aucune ligne —
  // entièrement testable sans dépendre d'un partenaire PPF, D1).
  async fetchConsultation(typeFlux: TypeFlux): Promise<ConsultationResult> {
    const path = join(this.baseDir, `f14-${typeFlux}.xml`)
    const xml = await readFile(path, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    })
    return { typeFlux, xml: xml ?? emptyConsultationXml(typeFlux) }
  }

  // Acquittement PPF (déposée/rejetée) appliqué par la machine à états de
  // publication (Task 8/9) ; le canal local n'a pas d'état PPF réel à
  // interroger ici — `pending` par défaut, quel que soit trackingRef.
  publicationStatus(trackingRef: string): Promise<AnnuaireAckStatus> {
    return Promise.resolve({ trackingRef, outcome: 'pending' })
  }
}
