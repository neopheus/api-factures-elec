import { createHash } from 'node:crypto'
import type { INestApplicationContext } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  ANNUAIRE_TRANSPORT,
  type AnnuaireAckStatus,
  type AnnuairePort,
  type ConsultationResult,
  type PublishPayload,
  type PublishResult,
} from '../../../src/annuaire/annuaire.port.js'
import type { TypeFlux } from '../../../src/annuaire/nomenclature.js'
import {
  ARCHIVE_STORE,
  type ArchiveHead,
  ArchiveObjectNotFoundError,
  type ArchivePutResult,
  type ArchiveStore,
} from '../../../src/archive/archive-store.port.js'
import { APP_POOL, createPool } from '../../../src/db/client.js'
import {
  FLUX10_TRANSMISSION,
  type Flux10TransmissionPort,
  type TransmissionStatus,
  type TransmitPayload,
  type TransmitResult,
} from '../../../src/ereporting/flux10-transmission.port.js'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from '../../../src/invoices/format-generator.port.js'
import { REDIS_CONNECTION } from '../../../src/queue/redis-connection.module.js'
import { WorkerModule } from '../../../src/worker/worker.module.js'

// Store d'archivage EN MÉMOIRE (hermétique) : le WorkerModule câble l'archivage
// best-effort (Task 6), donc SANS override tout worker de test écrirait de vrais
// bundles dans ./var/archive (pollution du répertoire de travail, croissance
// disque entre runs). Ce store par défaut garde les octets en RAM — fidèle au
// contrat (write-once, empreinte sha256) mais sans effet de bord FS. Les tests
// qui VÉRIFIENT l'archive passent explicitement un LocalFilesystemArchiveStore.
class InMemoryArchiveStore implements ArchiveStore {
  private readonly files = new Map<string, Buffer>()
  private fingerprint(key: string, b: Buffer): ArchivePutResult {
    return {
      location: `mem://${key}`,
      hash: createHash('sha256').update(b).digest('hex'),
      bytes: b.byteLength,
      alreadyExisted: this.files.has(key),
    }
  }
  async put(key: string, content: Buffer): Promise<ArchivePutResult> {
    const existing = this.files.get(key)
    if (existing) return this.fingerprint(key, existing) // write-once
    this.files.set(key, content)
    return { ...this.fingerprint(key, content), alreadyExisted: false }
  }
  async head(key: string): Promise<ArchiveHead> {
    const b = this.files.get(key)
    if (!b) return { exists: false }
    return {
      exists: true,
      hash: createHash('sha256').update(b).digest('hex'),
      bytes: b.byteLength,
    }
  }
  async get(key: string): Promise<Buffer> {
    const b = this.files.get(key)
    if (!b) throw new ArchiveObjectNotFoundError(key)
    return b
  }
}

// Sink de transmission Flux 10 EN MÉMOIRE (hermétique, motif
// InMemoryArchiveStore ci-dessus) : le WorkerModule câble EreportingTransmission
// Module (Task 8), qui — sans override — construirait un
// LocalFilesystemTransmissionStore écrivant dans ./var/ereporting (driver
// 'local' par défaut, EREPORTING_TRANSMISSION_DRIVER). Ce sink garde le XML
// en RAM, fidèle au contrat write-once (rejeu même transmissionRef -> même
// trackingId, jamais d'écrasement) mais sans effet de bord FS.
class InMemoryTransmissionSink implements Flux10TransmissionPort {
  private readonly store = new Map<string, string>()

  async transmit(payload: TransmitPayload): Promise<TransmitResult> {
    const key = `${payload.tenantId}/${payload.fluxKind}/${payload.transmissionRef}`
    const existing = this.store.get(key)
    if (existing === undefined) this.store.set(key, payload.xml)
    const xml = existing ?? payload.xml // write-once : jamais le contenu rejoué
    return {
      trackingId: createHash('sha256').update(xml, 'utf8').digest('hex'),
      location: `mem://${key}`,
    }
  }

  status(trackingId: string): Promise<TransmissionStatus> {
    return Promise.resolve({ trackingId, outcome: 'pending' })
  }
}

// F14 « vide » XSD-valide (HorodateProduction+TypeFlux seuls) — servi par
// défaut tant qu'aucun fixture n'a été déposé via `setConsultation` (motif
// LocalFilesystemAnnuaireStore.emptyConsultationXml, Task 6/9) : un test qui
// ne configure PAS de fixture pour un TypeFlux donné exerce ainsi le chemin
// « empty F14 → no-op » (injection revue Task 9) sans jamais toucher le
// filesystem.
function emptyConsultationXml(typeFlux: TypeFlux): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<AnnuaireConsultationF14>\n' +
    '  <HorodateProduction>20260101000000</HorodateProduction>\n' +
    `  <TypeFlux>${typeFlux}</TypeFlux>\n` +
    '</AnnuaireConsultationF14>'
  )
}

// Port annuaire EN MÉMOIRE (hermétique, motif InMemoryArchiveStore/
// InMemoryTransmissionSink ci-dessus) : le WorkerModule câble
// AnnuaireTransportModule (Task 9), qui — sans override — construirait un
// LocalFilesystemAnnuaireStore écrivant dans ./var/annuaire (driver 'local'
// par défaut, ANNUAIRE_DRIVER). Ce store garde le F13 publié EN RAM, fidèle
// au contrat write-once (rejeu même publicationRef -> même trackingRef,
// jamais d'écrasement — `publishCallCount()` permet aux tests de prouver
// qu'AUCUNE seconde écriture n'a eu lieu, seulement un second APPEL) et sert
// des fixtures F14 déterministes CONTRÔLÉES PAR LE TEST via
// `setConsultation` (contrairement au store réel, dont `fetchConsultation`
// n'a PAS de paramètre tenant — motif identique ici : la fixture est servie
// PAR TypeFlux, globalement, jamais par tenant).
class InMemoryAnnuaireStore implements AnnuairePort {
  private readonly published = new Map<string, string>()
  private readonly consultations = new Map<TypeFlux, string>()
  private calls = 0

  setConsultation(typeFlux: TypeFlux, xml: string): void {
    this.consultations.set(typeFlux, xml)
  }

  publishCallCount(): number {
    return this.calls
  }

  publish(payload: PublishPayload): Promise<PublishResult> {
    this.calls++
    const key = `${payload.tenantId}/${payload.publicationRef}`
    const existing = this.published.get(key)
    if (existing === undefined) this.published.set(key, payload.xml)
    const xml = existing ?? payload.xml // write-once : jamais le contenu rejoué
    return Promise.resolve({
      trackingRef: createHash('sha256').update(xml, 'utf8').digest('hex'),
      location: `mem://${key}`,
    })
  }

  fetchConsultation(typeFlux: TypeFlux): Promise<ConsultationResult> {
    return Promise.resolve({
      typeFlux,
      xml: this.consultations.get(typeFlux) ?? emptyConsultationXml(typeFlux),
    })
  }

  publicationStatus(trackingRef: string): Promise<AnnuaireAckStatus> {
    return Promise.resolve({ trackingRef, outcome: 'pending' })
  }
}

export { InMemoryAnnuaireStore }

// Boote le VRAI WorkerModule en-process contre le Postgres + Redis de test
// (overrides du pool applicatif et de la connexion Redis, comme createTestApp).
// opts.generator : stub de génération (ex. qui throw) pour tester les échecs.
// opts.archiveStore : override d'ARCHIVE_STORE (Task 6) — répertoire temporaire
// réel OU stub qui throw, pour tester l'archivage. Par défaut : store en mémoire
// hermétique (ci-dessus) → aucun test n'écrit dans ./var/archive sans le demander.
// opts.transmissionPort : override de FLUX10_TRANSMISSION (Task 8) — stub
// d'échec/de comptage d'appels pour prouver qu'un chemin (à blanc, XML
// invalide) n'appelle JAMAIS le port. Par défaut : sink en mémoire hermétique
// (ci-dessus) → aucun test n'écrit dans ./var/ereporting sans le demander.
// opts.annuairePort : override d'ANNUAIRE_TRANSPORT (Task 9) — passer une
// INSTANCE d'InMemoryAnnuaireStore pour contrôler ses fixtures F14
// (`setConsultation`) et sonder ses appels (`publishCallCount`) depuis le
// test. Par défaut : store en mémoire hermétique (ci-dessus) → aucun test
// n'écrit dans ./var/annuaire sans le demander.
export async function createTestWorker(
  appUrl: string,
  redis: { host: string; port: number },
  opts?: {
    generator?: InvoiceFormatGenerator
    archiveStore?: ArchiveStore
    transmissionPort?: Flux10TransmissionPort
    annuairePort?: AnnuairePort
  },
): Promise<INestApplicationContext> {
  process.env.DATABASE_URL = appUrl
  process.env.LOG_LEVEL = 'silent'
  const builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
    .overrideProvider(REDIS_CONNECTION)
    .useValue({ host: redis.host, port: redis.port })
    .overrideProvider(ARCHIVE_STORE)
    .useValue(opts?.archiveStore ?? new InMemoryArchiveStore())
    .overrideProvider(FLUX10_TRANSMISSION)
    .useValue(opts?.transmissionPort ?? new InMemoryTransmissionSink())
    .overrideProvider(ANNUAIRE_TRANSPORT)
    .useValue(opts?.annuairePort ?? new InMemoryAnnuaireStore())
  if (opts?.generator) {
    builder.overrideProvider(INVOICE_FORMAT_GENERATOR).useValue(opts.generator)
  }
  // `TestingModule` (retour de `.compile()`) ÉTEND directement
  // `NestApplicationContext` (@nestjs/testing 11.x) — pas de méthode
  // `createNestApplicationContext()` séparée à appeler : `moduleRef` EST déjà
  // le contexte applicatif. `.init()` déclenche le cycle de vie complet
  // (onModuleInit puis onApplicationBootstrap → démarre les Workers BullMQ,
  // upsert des planificateurs répétables).
  const ctx = await builder.compile()
  ctx.enableShutdownHooks()
  await ctx.init()
  return ctx
}

// Polling borné (JAMAIS de sleep fixe) : résout dès que `predicate()` est
// vrai, rejette après `timeoutMs`. Intervalle court pour un test réactif.
export async function waitFor(
  predicate: () => Promise<boolean>,
  {
    timeoutMs = 20_000,
    intervalMs = 100,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`)
}
