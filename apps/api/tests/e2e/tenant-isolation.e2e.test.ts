import type { InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { seedGeneratedInvoice } from './helpers/seed-invoice.js'

const invoice = (number: string): InvoiceInput => ({
  number,
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
})

describe('cross-tenant isolation (e2e, MANDATORY)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let tokenA: string
  let tokenB: string
  let invoiceIdA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    let tenantIdA: string
    ;({ tenantId: tenantIdA, token: tokenA } = await seedTenantWithKey(
      ownerPool,
      'A',
    ))
    ;({ token: tokenB } = await seedTenantWithKey(ownerPool, 'B'))
    app = await createTestApp(db.appUrl)
    invoiceIdA = await seedGeneratedInvoice(
      ownerPool,
      tenantIdA,
      invoice('A-1'),
    )
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('tenant A can read its own invoice (200)', async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceIdA}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200)
  })

  it("tenant B NEVER sees tenant A's invoice (404, not 200/403 leak)", async () => {
    const [asA, asB] = await Promise.all([
      request(app.getHttpServer())
        .get('/invoices/22222222-2222-2222-2222-222222222222')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404),
      request(app.getHttpServer())
        .get(`/invoices/${invoiceIdA}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(404),
    ])
    // 404 for another tenant's invoice must be structurally identical to a
    // true not-found (same problem body) — no distinguishable leak.
    expect(asB.body).toEqual(asA.body)
  })

  it("tenant B cannot read tenant A's generated formats (404)", async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceIdA}/formats/ubl`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404)
  })

  it("tenant B's listing excludes tenant A's invoices", async () => {
    const res = await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200)
    expect(res.body.items).toEqual([])
  })
})
