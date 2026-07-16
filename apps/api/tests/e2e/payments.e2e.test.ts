import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'
import { signupSession } from './helpers/session.js'

// Endpoint dual-auth de capture des encaissements (Task 5, plan 3.2) —
// checkpoint IMPÉRATIF (revue T4, MEDIUM-1) : 404-first STRICT AVANT toute
// écriture (facture inconnue OU cross-tenant, byte-identique, anti-fuite) ;
// intégrité vs facture (D5) : taxPercent ⊆ ventilation, cumul ≤ total TTC
// par taux ; idempotence (invoice_id, reference).
const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000'

function invoiceInput(number: string, vatRate = '20.00'): InvoiceInput {
  return {
    number,
    issueDate: '2026-07-13',
    dueDate: '2026-08-12',
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
        vatRate,
      },
    ],
  }
}

describe('payments capture & lecture (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let repo: InvoicesRepository
  let tenantId: string
  let token: string

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ownerPool.on('error', () => {})
    repo = new InvoicesRepository(new TenantContextService(ownerPool as never))
    ;({ tenantId, token } = await seedTenantWithKey(ownerPool, 'PAY-EP'))
  })

  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  async function seedInvoice(
    number: string,
    vatRate = '20.00',
  ): Promise<string> {
    const { id } = await repo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput(number, vatRate)),
    )
    return id
  }

  it('capture un encaissement (201) et le relit (GET) ; dual-auth clé machine & session', async () => {
    const invoiceId = await seedInvoice('FA-PAY-1')
    const capture = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        invoiceId,
        paymentDate: '20260715',
        reference: 'REF-1',
        subtotals: [{ taxPercent: '20.00', amount: '60.00' }],
      })
      .expect(201)
    expect(capture.body.created).toBe(true)
    expect(typeof capture.body.id).toBe('string')

    const list = await request(app.getHttpServer())
      .get(`/payments?invoiceId=${invoiceId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(list.body).toHaveLength(1)
    expect(list.body[0]).toMatchObject({
      id: capture.body.id,
      reference: 'REF-1',
      subtotals: [{ taxPercent: '20.00', amount: '60.00' }],
    })

    // Dual-auth : une session (du MÊME tenant que la clé, signup crée son
    // propre tenant — on capture donc sur une facture semée dans CE tenant).
    const session = await signupSession(app, {
      email: 'payments-session@example.com',
      password: 'a-strong-password-1',
      organizationName: 'PAY-session',
    })
    const sessionTenantId = (
      await ownerPool.query('SELECT tenant_id FROM authenticate_user($1)', [
        'payments-session@example.com',
      ])
    ).rows[0].tenant_id
    const { id: sessionInvoiceId } = await repo.insertReceived(
      sessionTenantId,
      buildInvoice(invoiceInput('FA-PAY-SESSION')),
    )
    const sessionCapture = await request(app.getHttpServer())
      .post('/payments')
      .set('Cookie', session.cookie)
      .set('X-CSRF-Token', session.csrf)
      .send({
        invoiceId: sessionInvoiceId,
        paymentDate: '20260715',
        reference: 'REF-SESSION',
        subtotals: [{ taxPercent: '20.00', amount: '50.00' }],
      })
      .expect(201)
    expect(sessionCapture.body.created).toBe(true)
  })

  it('est idempotent sur (invoice, reference) : re-POST identique → 200, pas de doublon', async () => {
    const invoiceId = await seedInvoice('FA-PAY-IDEMP')
    const body = {
      invoiceId,
      paymentDate: '20260715',
      reference: 'REF-IDEMP',
      subtotals: [{ taxPercent: '20.00', amount: '80.00' }],
    }
    const first = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201)
    expect(first.body.created).toBe(true)

    const second = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(200)
    expect(second.body).toEqual({ id: first.body.id, created: false })

    const rows = await ownerPool.query(
      'SELECT count(*) FROM payments WHERE invoice_id = $1',
      [invoiceId],
    )
    expect(Number(rows.rows[0].count)).toBe(1)
  })

  it('refuse un taux absent de la ventilation de la facture (422 validation)', async () => {
    const invoiceId = await seedInvoice('FA-PAY-RATE')
    const res = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        invoiceId,
        paymentDate: '20260715',
        reference: 'REF-RATE',
        subtotals: [{ taxPercent: '10.00', amount: '10.00' }],
      })
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
  })

  it('accepte un taxPercent posté dans un format différent du taux facturé (« 20.00 » vs « 20.0 »)', async () => {
    const invoiceId = await seedInvoice('FA-PAY-FORMAT', '20.0')
    await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        invoiceId,
        paymentDate: '20260715',
        reference: 'REF-FORMAT',
        subtotals: [{ taxPercent: '20.00', amount: '10.00' }],
      })
      .expect(201)
  })

  it('refuse un sur-encaissement cumulé au-delà du total TTC par taux (422 business-rule)', async () => {
    const invoiceId = await seedInvoice('FA-PAY-OVER') // TTC = 120.00 @ 20 %
    await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        invoiceId,
        paymentDate: '20260715',
        reference: 'REF-OVER-1',
        subtotals: [{ taxPercent: '20.00', amount: '80.00' }],
      })
      .expect(201)

    const res = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        invoiceId,
        paymentDate: '20260716',
        reference: 'REF-OVER-2',
        subtotals: [{ taxPercent: '20.00', amount: '50.00' }],
      })
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:business-rule-violation')

    const rows = await ownerPool.query(
      'SELECT count(*) FROM payments WHERE invoice_id = $1',
      [invoiceId],
    )
    expect(Number(rows.rows[0].count)).toBe(1) // seule REF-OVER-1 a écrit
  })

  it('renvoie 404 byte-identique pour une facture inconnue ET cross-tenant (anti-fuite), sans écriture', async () => {
    const invoiceId = await seedInvoice('FA-PAY-404')
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'PAY-EP-OTHER',
    )

    const unknown = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        invoiceId: UNKNOWN_ID,
        paymentDate: '20260715',
        reference: 'REF-404-A',
        subtotals: [{ taxPercent: '20.00', amount: '10.00' }],
      })
      .expect(404)
    const crossTenant = await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        invoiceId,
        paymentDate: '20260715',
        reference: 'REF-404-B',
        subtotals: [{ taxPercent: '20.00', amount: '10.00' }],
      })
      .expect(404)
    expect(unknown.body).toEqual(crossTenant.body)
    expect(unknown.headers['content-type']).toContain(
      'application/problem+json',
    )

    const rows = await ownerPool.query(
      'SELECT count(*) FROM payments WHERE invoice_id = $1',
      [invoiceId],
    )
    expect(Number(rows.rows[0].count)).toBe(0)

    const getUnknown = await request(app.getHttpServer())
      .get(`/payments?invoiceId=${UNKNOWN_ID}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)
    const getCrossTenant = await request(app.getHttpServer())
      .get(`/payments?invoiceId=${invoiceId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404)
    expect(getUnknown.body).toEqual(getCrossTenant.body)
  })

  it('auth manquante/invalide → 401 (POST et GET)', async () => {
    await request(app.getHttpServer())
      .post('/payments')
      .send({
        invoiceId: UNKNOWN_ID,
        paymentDate: '20260715',
        reference: 'REF-401',
        subtotals: [{ taxPercent: '20.00', amount: '10.00' }],
      })
      .expect(401)
    await request(app.getHttpServer())
      .post('/payments')
      .set('Authorization', 'Bearer not-a-valid-key')
      .send({
        invoiceId: UNKNOWN_ID,
        paymentDate: '20260715',
        reference: 'REF-401-B',
        subtotals: [{ taxPercent: '20.00', amount: '10.00' }],
      })
      .expect(401)
    await request(app.getHttpServer())
      .get(`/payments?invoiceId=${UNKNOWN_ID}`)
      .expect(401)
  })

  it('rejette une mutation de session sans le header CSRF → 403', async () => {
    const session = await signupSession(app, {
      email: 'payments-csrf@example.com',
      password: 'a-strong-password-1',
      organizationName: 'PAY-csrf',
    })
    await request(app.getHttpServer())
      .post('/payments')
      .set('Cookie', session.cookie)
      .send({
        invoiceId: UNKNOWN_ID,
        paymentDate: '20260715',
        reference: 'REF-CSRF',
        subtotals: [{ taxPercent: '20.00', amount: '10.00' }],
      })
      .expect(403)
  })
})
