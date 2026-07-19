// Effet de bord OBLIGATOIRE en première position (motif
// billing-endpoints.e2e.test.ts / helpers/billing-fake-env.ts) :
// ConfigModule.forRoot() valide process.env de façon SYNCHRONE dès le
// chargement transitif de WorkerModule — BILLING_DRIVER doit donc valoir
// 'fake' AVANT tout autre import touchant WorkerModule, sans quoi
// BillingPortModule construirait NoneBillingDriver (reportUsage lève
// systématiquement BillingDisabledError, jamais exploitable ici).
import './helpers/billing-fake-env.js'
import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BILLING_PORT } from '../../src/billing/billing.port.js'
import { BillingRepository } from '../../src/billing/billing.repository.js'
import type { FakeBillingDriver } from '../../src/billing/fake-billing.driver.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { BILLING_USAGE_JOB } from '../../src/queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../../src/queue/queue.constants.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Sweep quotidien de report d'usage billing (Task 9, phase 5 Stripe) : vérifie,
// contre un VRAI Postgres et un VRAI Redis (BullMQ, `createTestWorker` — d'où
// le classement HEAVY_TESTS, MÊME COMMIT, motif verrou heavy-suites.arch.test.ts),
// le sweep bout-en-bout — comptage des factures créées à J-1 (UTC),
// enregistrement idempotent (`billing_usage_reports`), report au driver
// (`FakeBillingDriver.reported`) puis marquage `reported_at` — ET l'idempotence
// d'un second sweep (aucune nouvelle ligne, aucun double report).
//
// ORDRE délibéré (seed AVANT `createTestWorker`) : `upsertJobScheduler`
// (BillingUsageScheduler) planifie sa PREMIÈRE itération quasi immédiatement
// (motif du planificateur BullMQ pour un job `every` neuf, constaté
// empiriquement) — si le tenant/les factures étaient seedés APRÈS le
// démarrage du worker, ce tick automatique pourrait s'exécuter la PREMIÈRE
// fois avec un état incomplet (tenant pas encore abonné, ou factures pas
// encore antidatées) et enregistrerait alors un `count` erroné pour
// (tenant, J-1) — verrouillé ensuite à vie par `ON CONFLICT DO NOTHING`
// (`BillingRepository.recordUsage`). Seeder D'ABORD élimine structurellement
// cette course : quel que soit le run (automatique ou l'appel explicite
// ci-dessous) qui exécute le PREMIER sweep, il voit déjà l'état final correct.
describe('sweep quotidien de report d’usage billing (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let billingRepo: BillingRepository
  let appRepo: InvoicesRepository

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    // Seed via un BillingRepository/InvoicesRepository liés à factelec_app
    // (attachCustomer/applyEvent + insertReceived requièrent ce rôle) —
    // distinct du worker sous test (factelec_worker) créé par `createTestWorker`.
    billingRepo = new BillingRepository(
      new TenantContextService(appPool),
      appPool,
    )
    appRepo = new InvoicesRepository(new TenantContextService(appPool))
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  function invoiceInput(number: string, buyerSiren: string): InvoiceInput {
    return {
      number,
      issueDate: '2026-07-16',
      typeCode: '380',
      currency: 'EUR',
      businessProcessType: 'B1',
      seller: {
        name: 'Vendeur SARL',
        siren: '111111111',
        address: { countryCode: 'FR' },
      },
      buyer: {
        name: 'Client SARL',
        siren: buyerSiren,
        address: { countryCode: 'FR' },
      },
      lines: [
        {
          id: '1',
          name: 'Bien',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '1000.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
      ],
    }
  }

  async function seedActiveTenant(
    name: string,
    customerId: string,
  ): Promise<string> {
    const t = await ownerPool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    const tenantId = t.rows[0].id
    await billingRepo.attachCustomer(tenantId, customerId)
    await billingRepo.applyEvent(tenantId, {
      customerId,
      occurredAt: new Date(),
      subscriptionId: `sub_${customerId}`,
      status: 'active',
      currentPeriodEnd: null,
    })
    return tenantId
  }

  async function seedInvoiceAt(
    tenantId: string,
    number: string,
    buyerSiren: string,
    createdAt: Date,
  ): Promise<string> {
    const { id } = await appRepo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput(number, buyerSiren)),
    )
    // Antidatage direct en SQL owner (motif cdv-transmission-sweep.e2e :
    // insertStatusEvent poserait created_at via now(), le sweep a besoin d'une
    // facture ANTÉRIEURE, hors de portée de l'API applicative).
    await ownerPool.query('UPDATE invoices SET created_at = $2 WHERE id = $1', [
      id,
      createdAt,
    ])
    return id
  }

  it('compte les factures créées à J-1 (UTC), reporte au driver, marque la ligne reportée ; un second sweep ne duplique rien', async () => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - 1)
    const day = d.toISOString().slice(0, 10)
    const dayTimestamp = new Date(`${day}T12:00:00.000Z`)

    // Seed COMPLET avant le démarrage du worker (cf. commentaire de tête) :
    // tenant abonné + les 2 factures déjà antidatées à J-1.
    const tenantId = await seedActiveTenant(
      'Billing Usage Sweep',
      'cus_billing_usage_sweep',
    )
    await seedInvoiceAt(tenantId, 'BILLING-USAGE-1', '900000201', dayTimestamp)
    await seedInvoiceAt(tenantId, 'BILLING-USAGE-2', '900000202', dayTimestamp)

    const worker = await createTestWorker(db.workerUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      // Le scheduler a enregistré le planificateur périodique (idempotent, bootstrap).
      const schedulers = await maintenanceQueue.getJobSchedulers()
      expect(
        schedulers.some(
          (s) => s.key === 'billing-usage' || s.name === BILLING_USAGE_JOB,
        ),
      ).toBe(true)

      const firstSweep = await maintenanceQueue.add(BILLING_USAGE_JOB, {})
      await waitFor(async () => (await firstSweep.getState()) === 'completed')

      await waitFor(async () => {
        const r = await ownerPool.query(
          'SELECT reported_at FROM billing_usage_reports WHERE tenant_id = $1 AND day = $2',
          [tenantId, day],
        )
        return r.rows[0]?.reported_at != null
      })

      const row = await ownerPool.query(
        'SELECT count, reported_at FROM billing_usage_reports WHERE tenant_id = $1 AND day = $2',
        [tenantId, day],
      )
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0].count).toBe(2)
      expect(row.rows[0].reported_at).not.toBeNull()

      const port = worker.get(BILLING_PORT) as FakeBillingDriver
      expect(port.reported).toContainEqual({
        customerId: 'cus_billing_usage_sweep',
        day,
        count: 2,
      })
      const reportedLengthBefore = port.reported.length

      // Second sweep : idempotent — recordUsage (ON CONFLICT DO NOTHING) ne
      // crée aucune nouvelle ligne, et la ligne déjà `reported_at` non-null
      // n'est plus jamais retournée par findUnreportedUsage → aucun second
      // appel à reportUsage pour ce tenant/jour.
      const secondSweep = await maintenanceQueue.add(BILLING_USAGE_JOB, {})
      await waitFor(async () => (await secondSweep.getState()) === 'completed')

      const rowsAfter = await ownerPool.query(
        'SELECT count(*)::int AS n FROM billing_usage_reports WHERE tenant_id = $1',
        [tenantId],
      )
      expect(rowsAfter.rows[0].n).toBe(1)
      expect(port.reported).toHaveLength(reportedLengthBefore)
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})
