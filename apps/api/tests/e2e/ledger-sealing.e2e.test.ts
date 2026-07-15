import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const invoiceInput: InvoiceInput = {
  number: 'FA-SEAL-1',
  issueDate: '2026-07-14',
  dueDate: '2026-08-13',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: { name: 'Vendeur', address: { countryCode: 'FR' } },
  buyer: { name: 'Acheteur', address: { countryCode: 'FR' } },
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

describe('invoice_status_events sealing (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: InvoicesRepository
  let tenantA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new InvoicesRepository(new TenantContextService(appPool as never))
    const a = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('A') RETURNING id",
    )
    tenantA = a.rows[0].id
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('has pgcrypto available (digest sha256)', async () => {
    const r = await ownerPool.query(
      "SELECT encode(digest('abc','sha256'),'hex') AS h",
    )
    expect(r.rows[0].h).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('forbids deleting an invoice that has a probative journal (23503)', async () => {
    const { id } = await repo.insertReceived(
      tenantA,
      buildInvoice(invoiceInput),
    )
    // insertReceived a écrit l'événement initial `deposee` → la FK RESTRICT
    // bloque la suppression, même pour l'owner (BYPASSRLS n'exempte pas des FK).
    await expect(
      ownerPool.query('DELETE FROM invoices WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23503' })
  })
})
