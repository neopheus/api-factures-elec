import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import { Queue } from 'bullmq'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GENERATE_JOB } from '../../src/queue/invoice-generation.job.js'
import { RECONCILE_INVOICES_JOB } from '../../src/queue/maintenance.job.js'
import {
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

const valid: InvoiceInput = {
  number: 'FA-ASYNC-1',
  issueDate: '2026-07-13',
  dueDate: '2026-08-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'Service',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

describe('asynchronous generation (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let token: string
  let tenantId: string
  const auth = () => `Bearer ${token}`

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('API enqueues but does NOT process without a worker; a worker then generates the 5 formats', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send(valid)
      .expect(201)
    const id = res.body.id
    expect(res.body.status).toBe('received')

    // (a) Sans worker : le job attend, la facture reste `received` (preuve
    // déterministe que l'API ne consomme pas — pas de double-consommation).
    const inspect = new Queue(INVOICE_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const counts = await inspect.getJobCounts(
        'waiting',
        'active',
        'completed',
      )
      expect(
        (counts.waiting ?? 0) + (counts.active ?? 0),
      ).toBeGreaterThanOrEqual(1)
      const still = await ownerPool.query(
        'SELECT status FROM invoices WHERE id = $1',
        [id],
      )
      expect(still.rows[0].status).toBe('received')

      // (b) On démarre le worker → génération → statut `generated`.
      const worker = await createTestWorker(db.workerUrl, redis)
      try {
        await waitFor(async () => {
          const r = await request(app.getHttpServer())
            .get(`/invoices/${id}`)
            .set('Authorization', auth())
          return r.body.status === 'generated'
        })
        const detail = await request(app.getHttpServer())
          .get(`/invoices/${id}`)
          .set('Authorization', auth())
          .expect(200)
        expect([...detail.body.availableFormats].sort()).toEqual([
          'cii',
          'facturx',
          'flux_base',
          'flux_full',
          'ubl',
        ])
        const n = await ownerPool.query(
          'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
          [id],
        )
        expect(n.rows[0].n).toBe(5)
      } finally {
        await worker.close()
      }
    } finally {
      await inspect.close()
    }
  })

  it('replaying a generation job is idempotent (still exactly 5 formats)', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send({ ...valid, number: 'FA-ASYNC-REPLAY' })
      .expect(201)
    const id = res.body.id
    const worker = await createTestWorker(db.workerUrl, redis)
    const replayQueue = new Queue(INVOICE_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      await waitFor(async () => {
        const r = await request(app.getHttpServer())
          .get(`/invoices/${id}`)
          .set('Authorization', auth())
        return r.body.status === 'generated'
      })
      // Rejeu explicite (jobId distinct → non dédupliqué) : delete+insert.
      const tenantRow = await ownerPool.query(
        'SELECT tenant_id FROM invoices WHERE id = $1',
        [id],
      )
      await replayQueue.add(
        GENERATE_JOB,
        { tenantId: tenantRow.rows[0].tenant_id, invoiceId: id },
        { jobId: `${id}-replay` },
      )
      await waitFor(async () => {
        const n = await ownerPool.query(
          'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
          [id],
        )
        // reste exactement 5 après rejeu (jamais 10)
        return n.rows[0].n === 5
      })
      const n = await ownerPool.query(
        'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
        [id],
      )
      expect(n.rows[0].n).toBe(5)
    } finally {
      await replayQueue.close()
      await worker.close()
    }
  })

  it('exhausted retries mark the invoice generation as failed', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send({ ...valid, number: 'FA-ASYNC-FAIL' })
      .expect(201)
    const id = res.body.id
    // Worker dont le générateur échoue systématiquement → après épuisement
    // des tentatives (GENERATION_JOB_ATTEMPTS, défaut 3, backoff exp) → failed.
    const worker = await createTestWorker(db.workerUrl, redis, {
      generator: { generate: () => Promise.reject(new Error('boom')) },
    })
    try {
      await waitFor(
        async () => {
          const r = await ownerPool.query(
            'SELECT status FROM invoices WHERE id = $1',
            [id],
          )
          return r.rows[0].status === 'failed'
        },
        { timeoutMs: 30_000 },
      )
      const r = await ownerPool.query(
        'SELECT status FROM invoices WHERE id = $1',
        [id],
      )
      expect(r.rows[0].status).toBe('failed')
    } finally {
      await worker.close()
    }
  })

  // Mandat contrôleur (réconciliation, comble le trou "received" orpheline
  // documenté au commentaire InvoicesService.ingest) : une facture insérée
  // DIRECTEMENT en base (comme si l'enfilement Redis avait échoué après la
  // persistance Postgres) n'a AUCUN job BullMQ qui la référence — aucun
  // retry ne peut la rattraper de lui-même. Le balayage périodique
  // (file `maintenance`, déclenché ici immédiatement plutôt que d'attendre
  // RECONCILIATION_SWEEP_EVERY_MS) doit la re-enfiler et la mener à `generated`.
  it('the reconciliation sweep re-enqueues an orphaned received invoice with no job', async () => {
    const canonical = buildInvoice({ ...valid, number: 'FA-ASYNC-ORPHAN' })
    const ins = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, status, canonical, created_at)
       VALUES ($1, $2, $3, $4, $5, 'received', $6::jsonb, now() - interval '10 minutes')
       RETURNING id`,
      [
        tenantId,
        canonical.number,
        canonical.typeCode,
        canonical.issueDate,
        canonical.currency,
        JSON.stringify(canonical),
      ],
    )
    const id = ins.rows[0].id

    const worker = await createTestWorker(db.workerUrl, redis)
    const maintQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      // Le scheduler a enregistré le planificateur périodique (idempotent).
      const schedulers = await maintQueue.getJobSchedulers()
      expect(
        schedulers.some(
          (s) =>
            s.key === 'invoice-reconciliation' ||
            s.name === RECONCILE_INVOICES_JOB,
        ),
      ).toBe(true)

      // Déclenchement immédiat (job ponctuel, sans attendre l'intervalle).
      await maintQueue.add(RECONCILE_INVOICES_JOB, {})
      await waitFor(
        async () => {
          const r = await ownerPool.query(
            'SELECT status FROM invoices WHERE id = $1',
            [id],
          )
          return r.rows[0].status === 'generated'
        },
        { timeoutMs: 30_000 },
      )
      const formats = await ownerPool.query(
        'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
        [id],
      )
      expect(formats.rows[0].n).toBe(5)
    } finally {
      await maintQueue.close()
      await worker.close()
    }
  })

  // Fix post-revue (Important) : le filet ne couvrait que `received`. Une
  // facture peut aussi rester bloquée en `generating` si l'écriture finale
  // du statut `failed` se perd dans la course décrite au rapport Task 3
  // (`@OnWorkerEvent('failed')` non attendu par `Worker.close()`) — le job
  // BullMQ est pourtant bien épuisé (`failed`, retenu 7 j par
  // `removeOnFail`). Ce job résiduel BLOQUERAIT un simple ré-enfilement
  // (dédup `jobId = invoiceId`) : le sweep doit d'abord l'évincer
  // (`InvoiceGenerationQueue.removeJob`) avant de ré-enfiler.
  it('the sweep evicts a residual failed job and regenerates an invoice stuck in `generating`', async () => {
    const canonical = buildInvoice({
      ...valid,
      number: 'FA-ASYNC-STUCK-GENERATING',
    })
    const ins = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, status, canonical, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'generating', $6::jsonb, now() - interval '20 minutes', now() - interval '20 minutes')
       RETURNING id`,
      [
        tenantId,
        canonical.number,
        canonical.typeCode,
        canonical.issueDate,
        canonical.currency,
        JSON.stringify(canonical),
      ],
    )
    const id = ins.rows[0].id

    // Fabrique un job RÉSIDUEL `failed` sous le MÊME jobId (1 seule
    // tentative pour échouer immédiatement, sans attendre le backoff) :
    // simule ce que `removeOnFail` laisserait en Redis après épuisement réel
    // des tentatives.
    const failingQueue = new Queue(INVOICE_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    const failingWorker = await createTestWorker(db.workerUrl, redis, {
      generator: { generate: () => Promise.reject(new Error('boom')) },
    })
    try {
      await failingQueue.add(
        GENERATE_JOB,
        { tenantId, invoiceId: id },
        { jobId: id, attempts: 1 },
      )
      await waitFor(async () => {
        const job = await failingQueue.getJob(id)
        if (!job) return false
        return (await job.getState()) === 'failed'
      })
    } finally {
      await failingWorker.close()
    }

    // Le worker qui vient d'échouer a, lui, correctement écrit `failed` (pas
    // de course dans ce test synchrone) — on simule ICI la perte de cette
    // écriture en reforçant `generating` avec un `updated_at` ancien, tout
    // en laissant le job `failed` résiduel intact dans Redis.
    await ownerPool.query(
      `UPDATE invoices SET status = 'generating', updated_at = now() - interval '20 minutes' WHERE id = $1`,
      [id],
    )

    const worker = await createTestWorker(db.workerUrl, redis)
    const maintQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      await maintQueue.add(RECONCILE_INVOICES_JOB, {})
      await waitFor(
        async () => {
          const r = await ownerPool.query(
            'SELECT status FROM invoices WHERE id = $1',
            [id],
          )
          return r.rows[0].status === 'generated'
        },
        { timeoutMs: 30_000 },
      )
      const formats = await ownerPool.query(
        'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
        [id],
      )
      expect(formats.rows[0].n).toBe(5)
    } finally {
      await maintQueue.close()
      await worker.close()
      await failingQueue.close()
    }
  })
})
