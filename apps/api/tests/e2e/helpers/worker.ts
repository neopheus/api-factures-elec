import type { INestApplicationContext } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { APP_POOL, createPool } from '../../../src/db/client.js'
import {
  INVOICE_FORMAT_GENERATOR,
  type InvoiceFormatGenerator,
} from '../../../src/invoices/format-generator.port.js'
import { REDIS_CONNECTION } from '../../../src/queue/redis-connection.module.js'
import { WorkerModule } from '../../../src/worker/worker.module.js'

// Boote le VRAI WorkerModule en-process contre le Postgres + Redis de test
// (overrides du pool applicatif et de la connexion Redis, comme createTestApp).
// opts.generator : stub de génération (ex. qui throw) pour tester les échecs.
export async function createTestWorker(
  appUrl: string,
  redis: { host: string; port: number },
  opts?: { generator?: InvoiceFormatGenerator },
): Promise<INestApplicationContext> {
  process.env.DATABASE_URL = appUrl
  process.env.LOG_LEVEL = 'silent'
  const builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
    .overrideProvider(REDIS_CONNECTION)
    .useValue({ host: redis.host, port: redis.port })
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
