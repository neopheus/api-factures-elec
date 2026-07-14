import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import type { GeneratedFormat } from '../../src/invoices/format-generator.port.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

// Tests DIRECTS du repository (Postgres réel, sans HTTP ni Redis) : couvre les
// méthodes consommées par le worker (Task 3) dont le chemin normal (5 formats
// non vides) est déjà exercé par async-generation.e2e.test.ts. Ici : lecture
// (`loadCanonical`) et la branche "formats vide" de `completeGeneration`
// (dette de couverture notée au rapport Task 2 sur l'ex-`saveFormats`).
const input: InvoiceInput = {
  number: 'FA-REPO-1',
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

describe('InvoicesRepository (e2e, Postgres réel)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantId: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool))
    ;({ tenantId } = await seedTenantWithKey(ownerPool))
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('loadCanonical returns the persisted invoice, and null when absent', async () => {
    const invoice = buildInvoice(input)
    const { id } = await repo.insertReceived(tenantId, invoice)

    const loaded = await repo.loadCanonical(tenantId, id)
    expect(loaded?.number).toBe('FA-REPO-1')

    const missing = await repo.loadCanonical(
      tenantId,
      '00000000-0000-0000-0000-000000000000',
    )
    expect(missing).toBeNull()
  })

  it('completeGeneration is atomic: empty formats still moves status to generated (no rows inserted)', async () => {
    const invoice = buildInvoice({ ...input, number: 'FA-REPO-EMPTY' })
    const { id } = await repo.insertReceived(tenantId, invoice)

    const empty: GeneratedFormat[] = []
    await repo.completeGeneration(tenantId, id, empty)

    const status = await ownerPool.query(
      'SELECT status FROM invoices WHERE id = $1',
      [id],
    )
    expect(status.rows[0].status).toBe('generated')
    const formats = await ownerPool.query(
      'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
      [id],
    )
    expect(formats.rows[0].n).toBe(0)
  })

  it('completeGeneration replaces existing formats (delete+insert, no duplicates on replay)', async () => {
    const invoice = buildInvoice({ ...input, number: 'FA-REPO-REPLACE' })
    const { id } = await repo.insertReceived(tenantId, invoice)
    const one: GeneratedFormat[] = [
      {
        kind: 'ubl',
        contentType: 'application/xml',
        bodyText: '<a/>',
        bodyBytes: null,
        byteSize: 4,
      },
    ]
    await repo.completeGeneration(tenantId, id, one)
    await repo.completeGeneration(tenantId, id, one)

    const formats = await ownerPool.query(
      'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
      [id],
    )
    expect(formats.rows[0].n).toBe(1)
  })
})
