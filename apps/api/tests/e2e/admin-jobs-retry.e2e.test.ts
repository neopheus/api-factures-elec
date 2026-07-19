import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication, INestApplicationContext } from '@nestjs/common'
import { Queue } from 'bullmq'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { GENERATE_JOB } from '../../src/queue/invoice-generation.job.js'
import { INVOICE_GENERATION_QUEUE } from '../../src/queue/queue.constants.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { extractCookie } from './helpers/session.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

const valid: InvoiceInput = {
  number: 'FA-JOBS-RETRY-1',
  issueDate: '2026-07-19',
  dueDate: '2026-08-18',
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

// Task 5 (spec §3) : POST /admin/jobs/:queue/retry — HEAVY (démarre un VRAI
// worker BullMQ, motif async-generation.e2e.test.ts) : la relance admin
// n'a de sens à vérifier que contre un job RÉELLEMENT `failed`, jamais un
// état simulé en base.
//
// Choix du scénario d'échec déterministe (documenté, motif demandé au
// rapport de tâche) : PAS un `invoiceId` inexistant — vérifié en lisant
// `InvoiceGenerationProcessor.process` (worker/invoice-generation.processor.ts)
// : `loadCanonical` renvoie `null` sur un id inconnu et le processor fait
// alors un no-op silencieux (`return`), donc le job termine `completed`,
// JAMAIS `failed` — cette voie ne produit aucun échec réel. PAS non plus un
// nom de job inconnu sur `maintenance` : `MaintenanceProcessor.process`
// journalise un simple `warn` par défaut et retourne SANS throw pour un
// `job.name` non reconnu — même topique, aucun échec réel.
//
// La voie choisie ici est celle DÉJÀ éprouvée par
// `async-generation.e2e.test.ts` (« exhausted retries mark the invoice
// generation as failed » / « the sweep evicts a residual failed job… ») :
// un VRAI worker dont le générateur de formats est un stub qui THROW
// systématiquement (`generator: { generate: () => Promise.reject(...) }`),
// combiné à un job enfilé avec `attempts: 1` (1 seule tentative, pas
// d'attente du backoff exponentiel par défaut) — le job échoue alors
// RÉELLEMENT, déterministiquement, en quelques dizaines de ms, sans jamais
// passer par `job.moveToFailed` (l'API `moveToFailed` étant réservée aux cas
// où produire un VRAI échec serait trop fragile, ce qui n'est pas le cas
// ici).
describe('admin retry de jobs échoués — invoice-generation (e2e heavy)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let worker: INestApplicationContext
  let ownerPool: pg.Pool
  let inspectQueue: Queue
  let cookie: string[]
  let csrf: string
  let tenantId: string

  async function adminLogin(): Promise<void> {
    const res = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'super-admin-passphrase-1' })
      .expect(200)
    cookie = res.headers['set-cookie'] as unknown as string[]
    csrf = extractCookie(cookie, 'factelec_csrf')
  }

  async function seedFailingInvoice(number: string): Promise<string> {
    const canonical = buildInvoice({ ...valid, number })
    const ins = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, status, canonical, created_at)
       VALUES ($1, $2, $3, $4, $5, 'received', $6::jsonb, now())
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
    return ins.rows[0].id
  }

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })

    const hash = await hashPassword('super-admin-passphrase-1')
    await ownerPool.query(
      "INSERT INTO platform_admins (email, password_hash) VALUES ('root@factelec.fr', $1)",
      [hash],
    )
    await adminLogin()

    const t = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Shop Jobs Retry') RETURNING id",
    )
    tenantId = t.rows[0].id

    // Worker dont le générateur échoue SYSTÉMATIQUEMENT (motif
    // async-generation.e2e.test.ts, même stub) — chaque job traité par ce
    // worker échoue réellement, quel que soit l'invoiceId visé.
    worker = await createTestWorker(db.workerUrl, redis, {
      generator: { generate: () => Promise.reject(new Error('boom')) },
    })
    inspectQueue = new Queue(INVOICE_GENERATION_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
  })

  afterAll(async () => {
    await inspectQueue.close()
    await worker.close()
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('404 problem pour une file hors allowlist (queue.constants.ts)', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/jobs/not-a-real-queue/retry')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(404)
    expect(res.body.type).toBe('urn:factelec:problem:not-found')
  })

  it('file vide (aucun job failed) → { retried: 0, errors: 0 }', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/jobs/${INVOICE_GENERATION_QUEUE}/retry`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200)
    expect(res.body).toEqual({ retried: 0, errors: 0 })
  })

  it('un job réellement échoué (1 tentative épuisée) → retry → { retried: 1, errors: 0 }, journalisé (admin_actions, tenant_id NULL)', async () => {
    const invoiceId = await seedFailingInvoice('FA-JOBS-RETRY-2')
    await inspectQueue.add(
      GENERATE_JOB,
      { tenantId, invoiceId },
      { jobId: invoiceId, attempts: 1 },
    )
    await waitFor(async () => {
      const job = await inspectQueue.getJob(invoiceId)
      if (!job) return false
      return (await job.getState()) === 'failed'
    })

    const res = await request(app.getHttpServer())
      .post(`/admin/jobs/${INVOICE_GENERATION_QUEUE}/retry`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({})
      .expect(200)
    expect(res.body).toEqual({ retried: 1, errors: 0 })

    const { rows } = await ownerPool.query(
      `SELECT action, tenant_id, detail FROM admin_actions
       WHERE action = 'retry_jobs' ORDER BY created_at DESC LIMIT 1`,
    )
    expect(rows[0]).toMatchObject({
      action: 'retry_jobs',
      tenant_id: null,
      detail: { queue: INVOICE_GENERATION_QUEUE, retried: 1, errors: 0 },
    })

    // Le worker (générateur qui throw toujours) reprend et fait rééchouer CE
    // MÊME job en arrière-plan dès que `job.retry()` l'a repassé en attente
    // (attempts:1 déjà épuisé → `failed` définitif dès la 2e tentative,
    // aucun backoff). On attend explicitement ce règlement AVANT de passer
    // au test suivant / au teardown : sans cette synchronisation, ce rejeu
    // resterait en vol pendant `afterAll` et pourrait tenter d'écrire via un
    // pool déjà fermé (bruit de teardown inoffensif mais évitable, motif
    // createPool `pool.on('error')`).
    await waitFor(async () => {
      const job = await inspectQueue.getJob(invoiceId)
      if (!job) return false
      return job.attemptsMade >= 2 && (await job.getState()) === 'failed'
    })
  })

  it('limit=1 borne le nombre de jobs échoués relancés en une passe', async () => {
    const idA = await seedFailingInvoice('FA-JOBS-RETRY-3A')
    const idB = await seedFailingInvoice('FA-JOBS-RETRY-3B')
    await inspectQueue.add(
      GENERATE_JOB,
      { tenantId, invoiceId: idA },
      { jobId: idA, attempts: 1 },
    )
    await inspectQueue.add(
      GENERATE_JOB,
      { tenantId, invoiceId: idB },
      { jobId: idB, attempts: 1 },
    )
    await waitFor(async () => {
      const [jobA, jobB] = await Promise.all([
        inspectQueue.getJob(idA),
        inspectQueue.getJob(idB),
      ])
      if (!jobA || !jobB) return false
      const [stateA, stateB] = await Promise.all([
        jobA.getState(),
        jobB.getState(),
      ])
      return stateA === 'failed' && stateB === 'failed'
    })

    const res = await request(app.getHttpServer())
      .post(`/admin/jobs/${INVOICE_GENERATION_QUEUE}/retry`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ limit: 1 })
      .expect(200)
    expect(res.body).toEqual({ retried: 1, errors: 0 })

    // Règlement du rejeu en arrière-plan AVANT le teardown (motif identique
    // au test précédent) — `getFailed` ne garantit PAS lequel de idA/idB est
    // repris en premier (ordre BullMQ interne non contractuel ici), donc on
    // attend simplement que LES DEUX soient de nouveau `failed` (celui qui
    // n'a pas été relancé l'est déjà et reste stable ; celui relancé y
    // retourne après sa 2e tentative, épuisée).
    await waitFor(async () => {
      const [jobA, jobB] = await Promise.all([
        inspectQueue.getJob(idA),
        inspectQueue.getJob(idB),
      ])
      if (!jobA || !jobB) return false
      const [stateA, stateB] = await Promise.all([
        jobA.getState(),
        jobB.getState(),
      ])
      return stateA === 'failed' && stateB === 'failed'
    })
  })
})
