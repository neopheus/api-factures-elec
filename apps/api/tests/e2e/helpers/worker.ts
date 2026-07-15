import { createHash } from 'node:crypto'
import type { INestApplicationContext } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import {
  ARCHIVE_STORE,
  type ArchiveHead,
  ArchiveObjectNotFoundError,
  type ArchivePutResult,
  type ArchiveStore,
} from '../../../src/archive/archive-store.port.js'
import { APP_POOL, createPool } from '../../../src/db/client.js'
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

// Boote le VRAI WorkerModule en-process contre le Postgres + Redis de test
// (overrides du pool applicatif et de la connexion Redis, comme createTestApp).
// opts.generator : stub de génération (ex. qui throw) pour tester les échecs.
// opts.archiveStore : override d'ARCHIVE_STORE (Task 6) — répertoire temporaire
// réel OU stub qui throw, pour tester l'archivage. Par défaut : store en mémoire
// hermétique (ci-dessus) → aucun test n'écrit dans ./var/archive sans le demander.
export async function createTestWorker(
  appUrl: string,
  redis: { host: string; port: number },
  opts?: { generator?: InvoiceFormatGenerator; archiveStore?: ArchiveStore },
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
