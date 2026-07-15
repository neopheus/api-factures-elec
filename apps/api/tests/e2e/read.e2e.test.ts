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

describe('GET /invoices (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  let tenantId: string
  let id: string
  const auth = () => `Bearer ${token}`

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl)
    id = await seedGeneratedInvoice(ownerPool, tenantId, invoice('R-1'))
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('GET /invoices/:id returns metadata + available formats', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${id}`)
      .set('Authorization', auth())
      .expect(200)
    expect(res.body).toMatchObject({
      id,
      number: 'R-1',
      typeCode: '380',
      status: 'generated',
    })
    expect(res.body.availableFormats.sort()).toEqual([
      'cii',
      'facturx',
      'flux_base',
      'flux_full',
      'ubl',
    ])
  })

  it('GET a non-existent / non-uuid id → 404 (never 500)', async () => {
    await request(app.getHttpServer())
      .get('/invoices/not-a-uuid')
      .set('Authorization', auth())
      .expect(404)
    await request(app.getHttpServer())
      .get('/invoices/22222222-2222-2222-2222-222222222222')
      .set('Authorization', auth())
      .expect(404)
  })

  it('serves each format with the correct Content-Type', async () => {
    const ubl = await request(app.getHttpServer())
      .get(`/invoices/${id}/formats/ubl`)
      .set('Authorization', auth())
      .expect(200)
    expect(ubl.headers['content-type']).toContain('application/xml')
    expect(ubl.text).toContain('<Invoice')

    // A2 (amendement task 8) : supertest ne bufferise PAS application/pdf dans
    // res.body par défaut — .buffer(true) + un parser binaire (collecte des
    // chunks) sont nécessaires pour récupérer les octets bruts et vérifier la
    // signature %PDF- + la taille exacte persistée (round-trip bytea intact).
    const pdf = await request(app.getHttpServer())
      .get(`/invoices/${id}/formats/facturx`)
      .set('Authorization', auth())
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => callback(null, Buffer.concat(chunks)))
      })
      .expect(200)
    expect(pdf.headers['content-type']).toContain('application/pdf')
    const pdfBody = pdf.body as Buffer
    expect(pdfBody.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    const stored = await ownerPool.query(
      'SELECT byte_size FROM invoice_formats WHERE invoice_id = $1 AND kind = $2',
      [id, 'facturx'],
    )
    expect(pdfBody.length).toBe(stored.rows[0].byte_size)
  })

  it('unknown format kind → 404', async () => {
    await request(app.getHttpServer())
      .get(`/invoices/${id}/formats/json`)
      .set('Authorization', auth())
      .expect(404)
  })

  it('paginates by keyset (limit + nextCursor)', async () => {
    // R-1 existe déjà (beforeAll) ; +2 factures → 3 au total.
    await seedGeneratedInvoice(ownerPool, tenantId, invoice('R-2'))
    await seedGeneratedInvoice(ownerPool, tenantId, invoice('R-3'))

    const p1 = await request(app.getHttpServer())
      .get('/invoices?limit=2')
      .set('Authorization', auth())
      .expect(200)
    expect(p1.body.items).toHaveLength(2)
    expect(p1.body.nextCursor).toBeTruthy()

    const p2 = await request(app.getHttpServer())
      .get(`/invoices?limit=2&cursor=${encodeURIComponent(p1.body.nextCursor)}`)
      .set('Authorization', auth())
      .expect(200)
    expect(p2.body.items.length).toBeGreaterThanOrEqual(1)
    expect(p2.body.nextCursor).toBeNull()

    // Pas de doublon ni de perte entre les deux pages.
    const ids = [...p1.body.items, ...p2.body.items].map(
      (i: { id: string }) => i.id,
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('clamps an out-of-range or non-numeric limit instead of erroring', async () => {
    const tooHigh = await request(app.getHttpServer())
      .get('/invoices?limit=1000')
      .set('Authorization', auth())
      .expect(200)
    expect(tooHigh.body.items.length).toBeLessThanOrEqual(100)

    const nonNumeric = await request(app.getHttpServer())
      .get('/invoices?limit=not-a-number')
      .set('Authorization', auth())
      .expect(200)
    expect(Array.isArray(nonNumeric.body.items)).toBe(true)
  })
})
