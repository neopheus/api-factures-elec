import type { InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminLoginCookies, seedEnrolledAdmin } from './helpers/admin-auth.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedGeneratedInvoice } from './helpers/seed-invoice.js'
import { type Session, signupSession } from './helpers/session.js'

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

describe('invoices read via session (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let sessA: Session
  let tenantA: string
  let invoiceA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    sessA = await signupSession(app, {
      email: 'a@shop.example',
      password: 'passphrase-aaaaaa-1',
      organizationName: 'Shop A',
      siren: null,
    })
    tenantA = (
      await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
        'a@shop.example',
      ])
    ).rows[0].tenant_id
    invoiceA = await seedGeneratedInvoice(ownerPool, tenantA, invoice('FA-A-1'))
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('a user session lists and reads its tenant invoices', async () => {
    const list = await request(app.getHttpServer())
      .get('/invoices')
      .set('Cookie', sessA.cookie)
      .expect(200)
    expect(list.body.items.map((i: { number: string }) => i.number)).toContain(
      'FA-A-1',
    )
    await request(app.getHttpServer())
      .get(`/invoices/${invoiceA}`)
      .set('Cookie', sessA.cookie)
      .expect(200)
  })

  it('a user session downloads a format', async () => {
    const res = await request(app.getHttpServer())
      .get(`/invoices/${invoiceA}/formats/ubl`)
      .set('Cookie', sessA.cookie)
      .expect(200)
    expect(res.headers['content-type']).toContain('application/xml')
  })

  it('ingestion (POST /invoices) still requires an API key, not a session', async () => {
    await request(app.getHttpServer())
      .post('/invoices')
      .set('Cookie', sessA.cookie)
      .send({})
      .expect(401)
  })

  it('an admin session cannot read tenant invoices (401)', async () => {
    // Admin déjà enrôlé TOTP dès le seed (Task 7, spec §5) : le cycle
    // d'enrôlement lui-même vit dans admin-totp.e2e.test.ts, pas ici.
    const admin = await seedEnrolledAdmin(
      ownerPool,
      'root@factelec.fr',
      'super-admin-passphrase-1',
    )
    const adminCookie = await adminLoginCookies(app, admin)
    await request(app.getHttpServer())
      .get('/invoices')
      .set('Cookie', adminCookie)
      .expect(401)
  })

  it('isolates tenants: B cannot read A invoice (404, byte-identical to a true not-found)', async () => {
    const sessB = await signupSession(app, {
      email: 'b@shop.example',
      password: 'passphrase-bbbbbb-1',
      organizationName: 'Shop B',
      siren: null,
    })
    const [crossTenant, trueNotFound] = await Promise.all([
      request(app.getHttpServer())
        .get(`/invoices/${invoiceA}`)
        .set('Cookie', sessB.cookie)
        .expect(404),
      request(app.getHttpServer())
        .get('/invoices/22222222-2222-2222-2222-222222222222')
        .set('Cookie', sessB.cookie)
        .expect(404),
    ])
    // Le 404 pour une facture d'un autre tenant doit être structurellement
    // identique à un vrai not-found (même corps problem) — aucune fuite
    // distinguable (parité avec tenant-isolation.e2e.test.ts, régime clé API).
    expect(crossTenant.body).toEqual(trueNotFound.body)
  })
})
