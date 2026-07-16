import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import type { Flux10TransmissionPort } from '../../src/ereporting/flux10-transmission.port.js'
import { computeDuePaymentPeriods } from '../../src/ereporting/period.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { PaymentsRepository } from '../../src/payments/payments.repository.js'
import {
  EREPORTING_GENERATE_JOB,
  type EreportingGenerationJob,
} from '../../src/queue/ereporting-generation.job.js'
import { EREPORTING_SWEEP_JOB } from '../../src/queue/maintenance.job.js'
import {
  EREPORTING_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { validateAgainstEreportingXsd } from '../helpers/ereporting-xsd.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Worker de génération e-reporting — slot `payments` (Task 8, plan 3.2) :
// période -> encaissements (RLS) -> agrégat 10.2/10.4 (aggregatePayments,
// ASYNC) -> Flux10Report{payments} XOR transactions -> XML XSD-validé ->
// persistance idempotente -> transmission via le port -> transmitted.
// Postgres + Redis RÉELS (Testcontainers), port de transmission remplacé par
// le sink en mémoire par défaut (helpers/worker.ts) — motif
// ereporting-generation.e2e.test.ts (Task 8, plan 2.3), dupliqué ici pour la
// branche payments (fichier séparé par tâche, cf. brief).

// Facture SERVICES pure (100 % services, nature de ligne complète), buyer
// non-assujetti (B2C domestique) -> classifyEreportingOperation = '10.3' ->
// agrégée dans PaymentsReport/Transactions (10.4). unitPrice 1000.00 @ 20 % ->
// taxable 1000.00, taxe 200.00, TTC 1200.00 (oracle retranscrit à la main,
// PAS dérivé du code — leçon anti-tautologie 3.1-T1).
const servicesInvoice = (
  number: string,
  sellerSiren: string,
  issueDate: string,
): InvoiceInput => ({
  number,
  issueDate,
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: {
    name: 'Vendeur',
    siren: sellerSiren,
    address: { countryCode: 'FR' },
  },
  buyer: { name: 'Client particulier', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'Prestation',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '1000.00',
      vatCategory: 'S',
      vatRate: '20.00',
      nature: 'services',
    },
  ],
})

// Stub de port comptant ses appels — SANS jamais réussir — motif
// ereporting-generation.e2e.test.ts : prouve qu'un chemin donné (à blanc, XML
// invalide) n'invoque JAMAIS `transmit`.
function neverCalledPort(): { port: Flux10TransmissionPort; calls(): number } {
  let calls = 0
  return {
    port: {
      transmit() {
        calls++
        return Promise.reject(
          new Error('FLUX10_TRANSMISSION.transmit must never be called here'),
        )
      },
      status(trackingId: string) {
        return Promise.resolve({ trackingId, outcome: 'pending' as const })
      },
    },
    calls: () => calls,
  }
}

describe('ereporting payments worker (e2e, Task 8 plan 3.2)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let invoicesRepo: InvoicesRepository
  let paymentsRepo: PaymentsRepository

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    const tenantContext = new TenantContextService(appPool)
    invoicesRepo = new InvoicesRepository(tenantContext)
    paymentsRepo = new PaymentsRepository(tenantContext)
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  async function makeTenant(name: string): Promise<string> {
    const t = await ownerPool.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    return t.rows[0].id
  }

  async function makeDeclarant(
    tenantId: string,
    siren: string,
    vatRegime = 'reel_normal_mensuel',
  ): Promise<string> {
    const d = await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
       VALUES ($1, $2, 'Déclarant e2e paiements', 'SE', $3) RETURNING id`,
      [tenantId, siren, vatRegime],
    )
    return d.rows[0].id
  }

  function jobPayload(
    over: Partial<EreportingGenerationJob> &
      Pick<EreportingGenerationJob, 'tenantId' | 'declarantId' | 'siren'>,
  ): EreportingGenerationJob {
    return {
      role: 'SE',
      fluxKind: 'payments',
      periodStart: '20260901',
      periodEnd: '20260910',
      type: 'IN',
      ...over,
    }
  }

  it('transmet un PaymentsReport 10.4 dû (encaissements capturés → 1 transmission payments)', async () => {
    const tenantId = await makeTenant('EREPAY-1')
    const siren = '111111111'
    const declarantId = await makeDeclarant(tenantId, siren)
    const { id: invoiceId } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(servicesInvoice('FA-PAY-1', siren, '2026-09-05') as never),
    )
    await paymentsRepo.insertPayment(tenantId, {
      invoiceId,
      paymentDate: '20260905',
      currency: 'EUR',
      reference: 'REF-1',
      subtotals: [{ taxPercent: '20.00', amount: '1200.00' }],
    })

    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )

      await waitFor(async () => {
        const r = await ownerPool.query(
          "SELECT status FROM ereporting_transmissions WHERE declarant_id = $1 AND flux_kind = 'payments'",
          [declarantId],
        )
        return r.rows[0]?.status === 'transmitted'
      })

      const rows = await ownerPool.query(
        `SELECT status, tracking_id, xml, invoice_count, transmission_ref, flux_kind
           FROM ereporting_transmissions WHERE declarant_id = $1`,
        [declarantId],
      )
      expect(rows.rows).toHaveLength(1)
      const row = rows.rows[0]
      expect(row.flux_kind).toBe('payments')
      expect(row.status).toBe('transmitted')
      expect(row.tracking_id).not.toBeNull()
      expect(row.invoice_count).toBe(1)
      expect(row.transmission_ref.length).toBeLessThanOrEqual(50)
      expect(row.xml).toContain('PaymentsReport')
      // Oracle indépendant (retranscrit à la main) : encaissement 1200.00 TTC
      // @ 20 %, facture 100 % services -> ratio 1 -> montant émis intégral,
      // formaté 19.6 (6 décimales, TT-99).
      expect(row.xml).toContain('<Amount>1200.000000</Amount>')
      const { valid, errors } = validateAgainstEreportingXsd(row.xml)
      expect(errors).toBe('')
      expect(valid).toBe(true)
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it("n'écrit rien si aucun encaissement sur la période (transmission à blanc optionnelle, D6)", async () => {
    const tenantId = await makeTenant('EREPAY-BLANK')
    const siren = '222222222'
    const declarantId = await makeDeclarant(tenantId, siren)
    // Aucun encaissement capturé pour ce déclarant/période.

    const { port, calls } = neverCalledPort()
    const worker = await createTestWorker(db.appUrl, redis, {
      transmissionPort: port,
    })
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      const job = await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(async () => (await job.getState()) === 'completed')

      const rows = await ownerPool.query(
        "SELECT count(*)::int AS n FROM ereporting_transmissions WHERE declarant_id = $1 AND flux_kind = 'payments'",
        [declarantId],
      )
      expect(rows.rows[0].n).toBe(0)
      expect(calls()).toBe(0)
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('slot payments distinct du slot transactions pour le même déclarant/période (flux_kind, D7)', async () => {
    const tenantId = await makeTenant('EREPAY-SLOT')
    const siren = '333333333'
    const declarantId = await makeDeclarant(tenantId, siren)
    const { id: invoiceId } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(
        servicesInvoice('FA-PAY-SLOT-1', siren, '2026-09-05') as never,
      ),
    )
    await paymentsRepo.insertPayment(tenantId, {
      invoiceId,
      paymentDate: '20260905',
      currency: 'EUR',
      reference: 'REF-SLOT-1',
      subtotals: [{ taxPercent: '20.00', amount: '1200.00' }],
    })

    const worker = await createTestWorker(db.appUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({
          tenantId,
          declarantId,
          siren,
          fluxKind: 'transactions',
        }),
      )
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren, fluxKind: 'payments' }),
      )

      await waitFor(async () => {
        const r = await ownerPool.query(
          "SELECT count(*)::int AS n FROM ereporting_transmissions WHERE declarant_id = $1 AND status = 'transmitted'",
          [declarantId],
        )
        return r.rows[0]?.n === 2
      })

      const rows = await ownerPool.query(
        `SELECT flux_kind, status, period_start FROM ereporting_transmissions
           WHERE declarant_id = $1 ORDER BY flux_kind`,
        [declarantId],
      )
      expect(rows.rows).toHaveLength(2)
      // `flux_kind` est un ENUM Postgres natif (schema.ts) : ORDER BY trie
      // par ordre de DÉCLARATION de l'enum ('transactions' puis 'payments'),
      // PAS alphabétiquement.
      expect(rows.rows.map((r: { flux_kind: string }) => r.flux_kind)).toEqual([
        'transactions',
        'payments',
      ])
      for (const row of rows.rows) {
        expect(row.status).toBe('transmitted')
        expect(row.period_start).toBe('20260901')
      }
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('born-rejette (REJ_SEMAN) un PaymentsReport XSD-invalide sans jamais appeler le port', async () => {
    const tenantId = await makeTenant('EREPAY-INVALID')
    const siren = '444444444'
    const declarantId = await makeDeclarant(tenantId, siren)
    const { id: invoiceId } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(
        servicesInvoice('FA-PAY-INVALID-1', siren, '2026-09-05') as never,
      ),
    )
    // Encaissement capturé DIRECTEMENT via le repository (bypass de la
    // validation DECIMAL_RE du endpoint dual-auth, motif
    // ereporting-generation.e2e.test.ts `VINGT` sur l'invoice) : '2E1' est un
    // taux Big.js-parseable (= 20, donc APPARIÉ au taux facturé 20.00, ratio
    // = 1, AUCUN crash) mais N'EST PAS un xs:decimal valide (notation
    // scientifique interdite en XSD) — la chaîne CAPTURÉE est réémise
    // VERBATIM par `prorateServiceSubtotals` (jamais reformatée), produisant
    // un <TaxPercent>2E1</TaxPercent> structurellement XSD-invalide sans
    // jamais lever d'exception dans le pipeline d'agrégation.
    await paymentsRepo.insertPayment(tenantId, {
      invoiceId,
      paymentDate: '20260905',
      currency: 'EUR',
      reference: 'REF-INVALID-1',
      subtotals: [{ taxPercent: '2E1', amount: '1200.00' }],
    })

    const { port, calls } = neverCalledPort()
    const worker = await createTestWorker(db.appUrl, redis, {
      transmissionPort: port,
    })
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      const job = await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({ tenantId, declarantId, siren }),
      )
      await waitFor(async () => (await job.getState()) === 'completed')

      const rows = await ownerPool.query(
        `SELECT id, status, xml, invoice_count FROM ereporting_transmissions
           WHERE declarant_id = $1 AND flux_kind = 'payments'`,
        [declarantId],
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0].status).toBe('rejetee')
      expect(rows.rows[0].invoice_count).toBe(1)
      expect(rows.rows[0].xml).toContain('2E1')
      expect(calls()).toBe(0)

      const events = await ownerPool.query(
        `SELECT from_status, to_status, motif, actor FROM ereporting_status_events
           WHERE transmission_id = $1`,
        [rows.rows[0].id],
      )
      expect(events.rows).toHaveLength(1)
      expect(events.rows[0]).toMatchObject({
        from_status: null,
        to_status: 'rejetee',
        motif: 'REJ_SEMAN',
        actor: 'platform',
      })
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('idempotent : re-sweep du même (déclarant, payments, période) ne double pas (3 couches, D7)', async () => {
    const tenantId = await makeTenant('EREPAY-SWEEP-IDEMP')
    const siren = '555555555'
    const declarantId = await makeDeclarant(tenantId, siren, 'simplifie')
    // Période RÉELLEMENT due maintenant pour ce régime (fonction pure, réelle
    // — PAS mockée dans ce fichier e2e), motif ereporting-sweep.e2e.test.ts :
    // aucune date absolue en dur, robuste à la date d'exécution du test.
    const duePeriods = computeDuePaymentPeriods('simplifie', new Date())
    const period = duePeriods[0]
    if (!period) throw new Error('aucune période paiement due (test invalide)')
    const { id: invoiceId } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(
        servicesInvoice('FA-PAY-IDEMP-1', siren, '2026-01-05') as never,
      ),
    )
    await paymentsRepo.insertPayment(tenantId, {
      invoiceId,
      paymentDate: period.periodStart,
      currency: 'EUR',
      reference: 'REF-IDEMP-1',
      subtotals: [{ taxPercent: '20.00', amount: '1200.00' }],
    })

    const worker = await createTestWorker(db.appUrl, redis)
    const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
      connection: { host: redis.host, port: redis.port },
    })
    try {
      const firstSweep = await maintenanceQueue.add(EREPORTING_SWEEP_JOB, {})
      await waitFor(async () => (await firstSweep.getState()) === 'completed')
      await waitFor(async () => {
        const r = await ownerPool.query(
          "SELECT status FROM ereporting_transmissions WHERE declarant_id = $1 AND flux_kind = 'payments' AND period_start = $2",
          [declarantId, period.periodStart],
        )
        return r.rows[0]?.status === 'transmitted'
      })
      const before = await ownerPool.query(
        "SELECT id, tracking_id FROM ereporting_transmissions WHERE declarant_id = $1 AND flux_kind = 'payments'",
        [declarantId],
      )
      expect(before.rows).toHaveLength(1)

      const secondSweep = await maintenanceQueue.add(EREPORTING_SWEEP_JOB, {})
      await waitFor(async () => (await secondSweep.getState()) === 'completed')

      const after = await ownerPool.query(
        "SELECT id, tracking_id FROM ereporting_transmissions WHERE declarant_id = $1 AND flux_kind = 'payments'",
        [declarantId],
      )
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].id).toBe(before.rows[0].id)
      expect(after.rows[0].tracking_id).toBe(before.rows[0].tracking_id)
    } finally {
      await maintenanceQueue.close()
      await worker.close()
    }
  })

  it("respecte la cadence paiement (une période non échue n'est pas enfilée)", async () => {
    const tenantId = await makeTenant('EREPAY-CADENCE')
    const siren = '666666666'
    const declarantId = await makeDeclarant(
      tenantId,
      siren,
      'reel_normal_mensuel',
    )
    // Le mois CIVIL contenant `now` n'est JAMAIS dû pour la cadence paiement
    // (échéance = le 11 du mois SUIVANT, toujours dans le futur relativement
    // à une date quelconque de ce même mois — propriété structurelle de
    // `monthCandidates`/`computeDuePaymentPeriods`, period.ts) : un
    // encaissement daté d'aujourd'hui ne doit JAMAIS être enfilé par le
    // sweep, quelle que soit la date d'exécution du test.
    const now = new Date()
    const currentMonthStart = `${now.getUTCFullYear()}${String(
      now.getUTCMonth() + 1,
    ).padStart(2, '0')}01`
    const { id: invoiceId } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(
        servicesInvoice('FA-PAY-CADENCE-1', siren, '2026-01-05') as never,
      ),
    )
    await paymentsRepo.insertPayment(tenantId, {
      invoiceId,
      paymentDate: currentMonthStart,
      currency: 'EUR',
      reference: 'REF-CADENCE-1',
      subtotals: [{ taxPercent: '20.00', amount: '1200.00' }],
    })

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
      const notDueJob = jobs.find(
        (j) =>
          j.data.declarantId === declarantId &&
          j.data.fluxKind === 'payments' &&
          j.data.periodStart === currentMonthStart,
      )
      expect(notDueJob).toBeUndefined()

      const rows = await ownerPool.query(
        "SELECT count(*)::int AS n FROM ereporting_transmissions WHERE declarant_id = $1 AND flux_kind = 'payments' AND period_start = $2",
        [declarantId, currentMonthStart],
      )
      expect(rows.rows[0].n).toBe(0)
    } finally {
      await generationQueue.close()
      await maintenanceQueue.close()
      await worker.close()
    }
  })
})
