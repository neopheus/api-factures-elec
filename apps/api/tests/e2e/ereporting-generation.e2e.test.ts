import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import { Queue } from 'bullmq'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import type { Flux10TransmissionPort } from '../../src/ereporting/flux10-transmission.port.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import {
  EREPORTING_GENERATE_JOB,
  type EreportingGenerationJob,
} from '../../src/queue/ereporting-generation.job.js'
import { EREPORTING_GENERATION_QUEUE } from '../../src/queue/queue.constants.js'
import { validateAgainstEreportingXsd } from '../helpers/ereporting-xsd.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { createTestWorker, waitFor } from './helpers/worker.js'

// Worker de génération e-reporting (Task 8, plan 2.3) — tâche d'INTÉGRATION :
// période -> factures (RLS) -> agrégat 10.3 -> Flux10Report -> XML
// XSD-validé -> persistance idempotente -> transmission via le port ->
// transmitted. Postgres + Redis RÉELS (Testcontainers), port de transmission
// remplacé par le sink en mémoire par défaut (helpers/worker.ts, Task 8) —
// aucun test n'écrit dans ./var/ereporting. Un worker PAR test
// (createTestWorker/close), motif async-generation.e2e.test.ts.

const b2cInvoice = (
  number: string,
  sellerSiren: string,
  issueDate: string,
): InvoiceInput => ({
  number,
  issueDate,
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'B1',
  seller: {
    name: 'Vendeur',
    siren: sellerSiren,
    address: { countryCode: 'FR' },
  },
  buyer: { name: 'Client particulier', address: { countryCode: 'FR' } },
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
})

// Stub de port comptant ses appels — SANS jamais réussir — pour prouver
// qu'un chemin donné (à blanc, XML invalide) n'invoque JAMAIS `transmit`
// (injection Task 8 #1/#6). Si l'implémentation régresse et l'appelle quand
// même, le job échoue bruyamment (throw) plutôt que de masquer l'appel.
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

describe('ereporting generation worker (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let invoicesRepo: InvoicesRepository

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ownerPool.on('error', () => {})
    appPool.on('error', () => {})
    invoicesRepo = new InvoicesRepository(new TenantContextService(appPool))
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
    role: 'SE' | 'BY' = 'SE',
  ): Promise<string> {
    const d = await ownerPool.query(
      `INSERT INTO ereporting_declarants (tenant_id, siren, name, role, vat_regime)
       VALUES ($1, $2, 'Déclarant e2e', $3, 'reel_normal_mensuel') RETURNING id`,
      [tenantId, siren, role],
    )
    return d.rows[0].id
  }

  function jobPayload(
    over: Partial<EreportingGenerationJob> &
      Pick<EreportingGenerationJob, 'tenantId' | 'declarantId' | 'siren'>,
  ): EreportingGenerationJob {
    return {
      role: 'SE',
      fluxKind: 'transactions',
      periodStart: '20260901',
      periodEnd: '20260910',
      type: 'IN',
      ...over,
    }
  }

  it('génère et transmet une transmission pour une période avec opérations (pipeline complet, XML XSD-valide, trackingId, événements prepared→transmitted)', async () => {
    const tenantId = await makeTenant('EREGEN-1')
    const siren = '111111111'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-GEN-1', siren, '2026-09-05')),
    )
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-GEN-2', siren, '2026-09-05')),
    )

    const worker = await createTestWorker(db.workerUrl, redis)
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
          'SELECT status FROM ereporting_transmissions WHERE declarant_id = $1',
          [declarantId],
        )
        return r.rows[0]?.status === 'transmitted'
      })

      const rows = await ownerPool.query(
        `SELECT status, tracking_id, xml, invoice_count, transmission_ref
           FROM ereporting_transmissions WHERE declarant_id = $1`,
        [declarantId],
      )
      expect(rows.rows).toHaveLength(1)
      const row = rows.rows[0]
      expect(row.status).toBe('transmitted')
      expect(row.tracking_id).not.toBeNull()
      expect(row.invoice_count).toBe(2)
      expect(row.transmission_ref.length).toBeLessThanOrEqual(50)
      const { valid, errors } = validateAgainstEreportingXsd(row.xml)
      expect(errors).toBe('')
      expect(valid).toBe(true)

      const events = await ownerPool.query(
        `SELECT from_status, to_status FROM ereporting_status_events
           WHERE transmission_id = (
             SELECT id FROM ereporting_transmissions WHERE declarant_id = $1
           ) ORDER BY created_at`,
        [declarantId],
      )
      expect(
        events.rows.map(
          (e: { from_status: string | null; to_status: string }) => [
            e.from_status,
            e.to_status,
          ],
        ),
      ).toEqual([
        [null, 'prepared'],
        ['prepared', 'transmitted'],
      ])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it("n'émet rien pour une période sans opération (transmission à blanc, D6) : aucune ligne, aucun appel au port", async () => {
    const tenantId = await makeTenant('EREGEN-BLANK')
    const siren = '222222222'
    const declarantId = await makeDeclarant(tenantId, siren)
    // Aucune facture insérée pour ce déclarant/période.

    const { port, calls } = neverCalledPort()
    const worker = await createTestWorker(db.workerUrl, redis, {
      transmissionPort: port,
    })
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      const job = await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({
          tenantId,
          declarantId,
          siren,
          periodStart: '20260801',
          periodEnd: '20260810',
        }),
      )
      await waitFor(async () => (await job.getState()) === 'completed')

      const rows = await ownerPool.query(
        'SELECT count(*)::int AS n FROM ereporting_transmissions WHERE declarant_id = $1',
        [declarantId],
      )
      expect(rows.rows[0].n).toBe(0)
      expect(calls()).toBe(0)
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('isole les transmissions par tenant (RLS)', async () => {
    const tenantA = await makeTenant('EREGEN-RLS-A')
    const tenantB = await makeTenant('EREGEN-RLS-B')
    const siren = '333333333'
    const declarantId = await makeDeclarant(tenantA, siren)
    await invoicesRepo.insertReceived(
      tenantA,
      buildInvoice(b2cInvoice('FA-GEN-RLS-1', siren, '2026-07-05')),
    )

    const worker = await createTestWorker(db.workerUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({
          tenantId: tenantA,
          declarantId,
          siren,
          periodStart: '20260701',
          periodEnd: '20260710',
        }),
      )
      await waitFor(async () => {
        const r = await ownerPool.query(
          'SELECT status FROM ereporting_transmissions WHERE declarant_id = $1',
          [declarantId],
        )
        return r.rows[0]?.status === 'transmitted'
      })

      const asB = await appPool.connect()
      try {
        await asB.query('BEGIN')
        await asB.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenantB,
        ])
        const r = await asB.query(
          'SELECT id FROM ereporting_transmissions WHERE declarant_id = $1',
          [declarantId],
        )
        expect(r.rowCount).toBe(0)
        await asB.query('ROLLBACK')
      } finally {
        asB.release()
      }

      const asA = await appPool.connect()
      try {
        await asA.query('BEGIN')
        await asA.query("SELECT set_config('app.tenant_id', $1, true)", [
          tenantA,
        ])
        const r = await asA.query(
          'SELECT id FROM ereporting_transmissions WHERE declarant_id = $1',
          [declarantId],
        )
        expect(r.rowCount).toBe(1)
        await asA.query('COMMIT')
      } finally {
        asA.release()
      }
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('un rejeu du job ne duplique ni la transmission ni les événements (idempotence, injection #4)', async () => {
    const tenantId = await makeTenant('EREGEN-REPLAY')
    const siren = '444444444'
    const declarantId = await makeDeclarant(tenantId, siren)
    await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(b2cInvoice('FA-GEN-REPLAY-1', siren, '2026-06-05')),
    )
    const payload = jobPayload({
      tenantId,
      declarantId,
      siren,
      periodStart: '20260601',
      periodEnd: '20260610',
    })

    const worker = await createTestWorker(db.workerUrl, redis)
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      await queue.add(EREPORTING_GENERATE_JOB, payload)
      await waitFor(async () => {
        const r = await ownerPool.query(
          'SELECT status FROM ereporting_transmissions WHERE declarant_id = $1',
          [declarantId],
        )
        return r.rows[0]?.status === 'transmitted'
      })
      const before = await ownerPool.query(
        'SELECT id, tracking_id FROM ereporting_transmissions WHERE declarant_id = $1',
        [declarantId],
      )
      expect(before.rows).toHaveLength(1)

      // Rejeu explicite : MÊME payload, un job BullMQ distinct (jobId
      // différent — la dédup BullMQ elle-même est déjà couverte par
      // ereporting-sweep.e2e.test.ts, T7). L'idempotence testée ICI est
      // celle du SERVICE au niveau base (insertTransmission created:false).
      const replay = await queue.add(EREPORTING_GENERATE_JOB, payload)
      await waitFor(async () => (await replay.getState()) === 'completed')

      const after = await ownerPool.query(
        'SELECT id, tracking_id FROM ereporting_transmissions WHERE declarant_id = $1',
        [declarantId],
      )
      expect(after.rows).toHaveLength(1)
      expect(after.rows[0].id).toBe(before.rows[0].id)
      expect(after.rows[0].tracking_id).toBe(before.rows[0].tracking_id)

      const events = await ownerPool.query(
        'SELECT to_status FROM ereporting_status_events WHERE transmission_id = $1',
        [before.rows[0].id],
      )
      expect(
        events.rows.map((e: { to_status: string }) => e.to_status),
      ).toEqual(['prepared', 'transmitted'])
    } finally {
      await queue.close()
      await worker.close()
    }
  })

  it('un XML XSD-invalide (payload piégé) est rejeté localement (REJ_SEMAN), sans jamais appeler le port', async () => {
    const tenantId = await makeTenant('EREGEN-INVALID')
    const siren = '555555555'
    const declarantId = await makeDeclarant(tenantId, siren)
    // Facture insérée DIRECTEMENT (bypass invoice-core, motif
    // ereporting-persistence.e2e.test.ts `invoicesForPeriod`) : un
    // `vatBreakdown.rate` non numérique traverse aggregateTransactions sans
    // erreur (aucun calcul Big.js dessus) mais produit un <TaxPercent>
    // non-xs:decimal — XSD-invalide de façon 100% réaliste, sans stub du
    // générateur.
    await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, $2, '380', $3, 'EUR', $4::jsonb)`,
      [
        tenantId,
        'FA-GEN-INVALID',
        '2026-10-05',
        JSON.stringify({
          number: 'FA-GEN-INVALID',
          issueDate: '2026-10-05',
          currency: 'EUR',
          seller: { siren, address: { countryCode: 'FR' } },
          buyer: { address: { countryCode: 'FR' } },
          vatBreakdown: [
            { rate: 'VINGT', taxableAmount: '100.00', taxAmount: '20.00' },
          ],
        }),
      ],
    )

    const { port, calls } = neverCalledPort()
    const worker = await createTestWorker(db.workerUrl, redis, {
      transmissionPort: port,
    })
    const queue = new Queue<EreportingGenerationJob>(
      EREPORTING_GENERATION_QUEUE,
      { connection: { host: redis.host, port: redis.port } },
    )
    try {
      const job = await queue.add(
        EREPORTING_GENERATE_JOB,
        jobPayload({
          tenantId,
          declarantId,
          siren,
          periodStart: '20261001',
          periodEnd: '20261010',
        }),
      )
      await waitFor(async () => (await job.getState()) === 'completed')

      const rows = await ownerPool.query(
        `SELECT id, status, xml, invoice_count FROM ereporting_transmissions
           WHERE declarant_id = $1`,
        [declarantId],
      )
      expect(rows.rows).toHaveLength(1)
      expect(rows.rows[0].status).toBe('rejetee')
      expect(rows.rows[0].invoice_count).toBe(1)
      expect(rows.rows[0].xml).toContain('VINGT')
      // Preuve directe (pas seulement l'absence de trackingId) : le port n'a
      // jamais été invoqué — le stub aurait throw et fait échouer le job sinon.
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
})
