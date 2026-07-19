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
    // Fenêtre de rattrapage I2 (BILLING_USAGE_LOOKBACK_DAYS, défaut 3, non
    // surchargé par billing-fake-env.ts) : le sweep balaie désormais J-3,
    // J-2 ET J-1, PAS seulement J-1 (comportement pré-I2). Seules les
    // factures de J-1 sont seedées ci-dessous — J-3/J-2 restent SANS
    // document : `recordUsage` y écrit quand même une ligne count=0 (le
    // sweep ne sait pas a priori qu'un jour de la fenêtre est vide tant
    // qu'il ne l'a pas compté ; ces lignes count=0 sont le comportement
    // ACTUEL assumé pour un jour balayé sans activité — noté M14 dans la
    // revue, délibérément HORS PÉRIMÈTRE de ce correctif I2).
    const d1 = new Date()
    d1.setUTCDate(d1.getUTCDate() - 1)
    const day = d1.toISOString().slice(0, 10)
    const dayTimestamp = new Date(`${day}T12:00:00.000Z`)
    const d2 = new Date()
    d2.setUTCDate(d2.getUTCDate() - 2)
    const dayMinus2 = d2.toISOString().slice(0, 10)
    const d3 = new Date()
    d3.setUTCDate(d3.getUTCDate() - 3)
    const dayMinus3 = d3.toISOString().slice(0, 10)

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

      // Fenêtre I2 : J-3 et J-2, sans document, sont TOUT DE MÊME balayés —
      // une ligne count=0 par jour, elle aussi reportée/marquée (M14, hors
      // périmètre, cf. commentaire de tête du test).
      const olderRows = await ownerPool.query(
        'SELECT day, count, reported_at FROM billing_usage_reports WHERE tenant_id = $1 AND day IN ($2, $3) ORDER BY day',
        [tenantId, dayMinus3, dayMinus2],
      )
      expect(olderRows.rows).toHaveLength(2)
      expect(olderRows.rows[0]).toMatchObject({ day: dayMinus3, count: 0 })
      expect(olderRows.rows[1]).toMatchObject({ day: dayMinus2, count: 0 })
      expect(olderRows.rows[0].reported_at).not.toBeNull()
      expect(olderRows.rows[1].reported_at).not.toBeNull()

      const port = worker.get(BILLING_PORT) as FakeBillingDriver
      expect(port.reported).toContainEqual({
        customerId: 'cus_billing_usage_sweep',
        day,
        count: 2,
      })
      const reportedLengthBefore = port.reported.length

      // Second sweep : idempotent — recordUsage (ON CONFLICT DO NOTHING) ne
      // crée aucune nouvelle ligne pour AUCUN des 3 jours de la fenêtre, et
      // les lignes déjà `reported_at` non-null ne sont plus jamais
      // retournées par findUnreportedUsage → aucun second appel à
      // reportUsage pour ce tenant.
      const secondSweep = await maintenanceQueue.add(BILLING_USAGE_JOB, {})
      await waitFor(async () => (await secondSweep.getState()) === 'completed')

      const rowsAfter = await ownerPool.query(
        'SELECT count(*)::int AS n FROM billing_usage_reports WHERE tenant_id = $1',
        [tenantId],
      )
      // 3 lignes (J-3, J-2, J-1) — PAS 1 : c'est exactement le changement de
      // comportement I2 que ce test verrouille.
      expect(rowsAfter.rows[0].n).toBe(3)
      expect(port.reported).toHaveLength(reportedLengthBefore)
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})
