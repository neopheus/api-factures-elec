import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'

const valid = {
  number: 'FA-2026-1',
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

describe('POST /invoices (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  const auth = () => `Bearer ${token}`

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('rejects an unauthenticated request → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .send(valid)
      .expect(401)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
  })

  it('ingests a valid invoice → 201 received, no formats yet (async)', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send(valid)
      .expect(201)
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.body.status).toBe('received')
    const inv = await ownerPool.query(
      'SELECT status FROM invoices WHERE id = $1',
      [res.body.id],
    )
    expect(inv.rows[0].status).toBe('received')
    const n = await ownerPool.query(
      'SELECT count(*)::int AS n FROM invoice_formats WHERE invoice_id = $1',
      [res.body.id],
    )
    expect(n.rows[0].n).toBe(0) // génération déférée au worker (aucun worker ici)
  })

  it('rejects a structurally invalid payload → 422 validation', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send({ ...valid, number: undefined })
      .expect(422)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
    expect(
      res.body.errors.some((e: { path: string }) => e.path === 'number'),
    ).toBe(true)
  })

  it('rejects a business-rule violation → 422 businessRule (exempt category without reason, BR-E-10)', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send({
        ...valid,
        number: 'FA-2026-E',
        lines: [
          {
            id: '1',
            name: 'Export',
            quantity: '1',
            unitCode: 'C62',
            unitPrice: '100.00',
            vatCategory: 'E',
            vatRate: '0.00',
          },
        ],
      })
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:business-rule-violation')
    expect(
      res.body.errors.some((v: { rule: string }) => v.rule === 'BR-E-10'),
    ).toBe(true)
  })

  it('is idempotent on (tenant, number) → 409 on duplicate', async () => {
    const body = { ...valid, number: 'FA-2026-DUP' }
    await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send(body)
      .expect(201)
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send(body)
      .expect(409)
    expect(res.body.type).toBe('urn:factelec:problem:conflict')
  })

  it('scopes idempotence per tenant: a second tenant may reuse the same invoice number', async () => {
    const body = { ...valid, number: 'FA-2026-SHARED' }
    await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send(body)
      .expect(201)
    const { token: otherToken } = await seedTenantWithKey(
      ownerPool,
      'Other tenant',
    )
    await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${otherToken}`)
      .send(body)
      .expect(201)
  })

  // Amendement Task 4 : CsrfGuard ne s'applique JAMAIS aux chemins machine
  // (ApiKeyGuard/Bearer) — seules les mutations authentifiées par session
  // cookie l'exigent. InvoicesController n'est gardé que par ApiKeyGuard :
  // aucun en-tête X-CSRF-Token n'est envoyé ici, la requête doit réussir.
  it('never requires a CSRF header on a machine (API key) path', async () => {
    await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', auth())
      .send({ ...valid, number: 'FA-2026-NO-CSRF' })
      .expect(201)
  })
})
