import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EREPORTING_SWEEP_JOB } from '../../src/queue/maintenance.job.js'
import {
  EREPORTING_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Ordonnanceur e-reporting (Task 7, plan 2.3) : vérifie, contre un VRAI
// Redis (BullMQ) et un VRAI Postgres (find_ereporting_declarants_due, SD
// cross-tenant — migration 0017), que le balayage (1) enfile bien un job
// `ereporting-generation` PAR (déclarant, période due), et (2) — amendement
// plan A5, à vérifier EMPIRIQUEMENT — qu'un second balayage ne duplique
// JAMAIS ces jobs : le `jobId` déterministe `${declarantId}:${fluxKind}:
// ${periodStart}` est bien déduplique par BullMQ tant que le job existe
// encore dans Redis. C'est la couche 2 de la défense en profondeur anti
// double-envoi documentée dans ereporting-sweep.service.ts (couches 1 et 3 :
// fenêtre bornée de period.ts, et index unique partiel + insertTransmission
// idempotent, Task 5).
describe('ereporting sweep — jobId dedup empirique + un job par déclarant×période (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantId: string
  let declarantId: string

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    const t = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('EREP-SWEEP') RETURNING id",
    )
    tenantId = t.rows[0].id
    const d = await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime, active)
       VALUES ($1, '111111111', 'Vendeur Sweep', 'SE', 'reel_normal_mensuel', true)
       RETURNING id`,
      [tenantId],
    )
    declarantId = d.rows[0].id
    // Déclarant INACTIF : ne doit jamais donner lieu à un enfilement (déjà
    // couvert par le SD find_ereporting_declarants_due, Task 5 — re-vérifié
    // ici bout-en-bout via le sweep réel).
    await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime, active)
       VALUES ($1, '222222222', 'Inactif', 'SE', 'franchise', false)`,
      [tenantId],
    )
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('the scheduler registers the repeatable ereporting-sweep job scheduler (idempotent bootstrap)', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const schedulers = await maintenanceQueue.getJobSchedulers()
      expect(
        schedulers.some(
          (s) =>
            s.key === 'ereporting-sweep' || s.name === EREPORTING_SWEEP_JOB,
        ),
      ).toBe(true)
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it('a sweep enqueues exactly MAX_DUE_PERIODS ereporting-generation jobs for the active declarant, none for the inactive one', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const generationQueue = new Queue(EREPORTING_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const sweepJob = await maintenanceQueue.add(EREPORTING_SWEEP_JOB, {})
      await waitFor(async () => (await sweepJob.getState()) === 'completed')

      const jobs = await generationQueue.getJobs([
        'waiting',
        'active',
        'delayed',
        'completed',
      ])
      // MAX_DUE_PERIODS = 2 (period.ts, amendement A2-plan) : la décade
      // tout juste échue + une de rattrapage, pour l'UNIQUE déclarant actif.
      expect(jobs).toHaveLength(2)
      for (const job of jobs) {
        expect(job.id?.startsWith(`${declarantId}:transactions:`)).toBe(true)
        expect(job.data).toMatchObject({
          tenantId,
          declarantId,
          siren: '111111111',
          role: 'SE',
          fluxKind: 'transactions',
          type: 'IN',
        })
      }
    } finally {
      await generationQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it('a SECOND sweep does NOT duplicate jobs — BullMQ dedups by deterministic jobId (amendement A5, vérifié empiriquement)', async () => {
    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const generationQueue = new Queue(EREPORTING_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const firstSweep = await maintenanceQueue.add(EREPORTING_SWEEP_JOB, {})
      await waitFor(async () => (await firstSweep.getState()) === 'completed')
      const beforeIds = (
        await generationQueue.getJobs([
          'waiting',
          'active',
          'delayed',
          'completed',
        ])
      )
        .map((j) => j.id)
        .sort()

      const secondSweep = await maintenanceQueue.add(EREPORTING_SWEEP_JOB, {})
      await waitFor(async () => (await secondSweep.getState()) === 'completed')
      const afterIds = (
        await generationQueue.getJobs([
          'waiting',
          'active',
          'delayed',
          'completed',
        ])
      )
        .map((j) => j.id)
        .sort()

      // Même jeu de jobId AVANT/APRÈS le second balayage : ni doublon, ni
      // perte — la déduplication BullMQ par jobId fonctionne bien pendant
      // la rétention du job (couche 2 de la défense en profondeur).
      expect(afterIds).toEqual(beforeIds)
      expect(afterIds).toHaveLength(2)
    } finally {
      await generationQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})
