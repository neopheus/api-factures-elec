import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { InvoiceReconciliationService } from '../../src/worker/invoice-reconciliation.service.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const input: InvoiceInput = {
  number: 'FA-POISON-1',
  issueDate: '2026-07-14',
  dueDate: '2026-08-13',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'V', address: { countryCode: 'FR' } },
  buyer: { name: 'A', address: { countryCode: 'FR' } },
  lines: [
    {
      id: '1',
      name: 'S',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}
// Config stub : stale=0 (toute facture est « stuck »), cap=2.
const config = {
  get: (k: string) =>
    ({
      RECONCILIATION_STALE_MS: 0,
      RECONCILIATION_GENERATING_STALE_MS: 0,
      GENERATION_MAX_ATTEMPTS_CAP: 2,
    })[k],
} as never
// Queue stub : aucune existence de job, capture des enfilements.
const enqueue = vi.fn(async () => {})
const queue = {
  getJobState: async () => undefined,
  removeJob: async () => {},
  enqueue,
} as never

describe('poison invoice reconciliation cap → DLQ (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let svc: InvoiceReconciliationService
  let tenantId: string
  let invoiceId: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool))
    svc = new InvoiceReconciliationService(
      appPool as never,
      queue,
      repo,
      config,
    )
    tenantId = (
      await ownerPool.query(
        "INSERT INTO tenants (name) VALUES ('POISON') RETURNING id",
      )
    ).rows[0].id
    // Facture 'received' (stuck) : insertReceived puis vieillissement du created_at.
    ;({ id: invoiceId } = await repo.insertReceived(
      tenantId,
      buildInvoice(input),
    ))
    await ownerPool.query(
      "UPDATE invoices SET created_at = now() - interval '1 hour' WHERE id = $1",
      [invoiceId],
    )
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('re-enqueues up to the cap, then dead-letters the poison invoice', async () => {
    await svc.sweepStuckGeneration() // attempts 1 → enqueue
    await svc.sweepStuckGeneration() // attempts 2 → enqueue
    expect(enqueue).toHaveBeenCalledTimes(2)
    await svc.sweepStuckGeneration() // attempts 3 > cap 2 → DLQ, pas d'enqueue
    expect(enqueue).toHaveBeenCalledTimes(2) // inchangé
    // Facture neutralisée : failed + entrée DLQ, plus jamais ré-enfilée.
    const inv = await ownerPool.query(
      'SELECT status FROM invoices WHERE id = $1',
      [invoiceId],
    )
    expect(inv.rows[0].status).toBe('failed')
    const dl = await ownerPool.query(
      'SELECT reason, attempts FROM invoice_dead_letters WHERE invoice_id = $1',
      [invoiceId],
    )
    expect(dl.rows).toHaveLength(1)
    expect(dl.rows[0]).toMatchObject({
      reason: 'generation attempts cap exceeded',
      attempts: 3,
    })
    // Un sweep de plus ne fait plus rien (find_stuck_* ignore les failed).
    await svc.sweepStuckGeneration()
    expect(enqueue).toHaveBeenCalledTimes(2)
  })

  it('keeps invoice_dead_letters APPEND-ONLY for factelec_app (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ])
      await expect(
        client.query("UPDATE invoice_dead_letters SET reason = 'x'"),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('rejects DELETE on invoice_dead_letters for factelec_app (42501)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ])
      await expect(
        client.query('DELETE FROM invoice_dead_letters'),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })
})
