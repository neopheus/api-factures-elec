import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { type Session, signupSession } from './helpers/session.js'

async function seedInvoice(
  ownerPool: pg.Pool,
  tenantId: string,
  number: string,
): Promise<string> {
  const inv = await ownerPool.query(
    `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
     VALUES ($1, $2, '380', '2026-07-13', 'EUR', '{}'::jsonb) RETURNING id`,
    [tenantId, number],
  )
  const id = inv.rows[0].id
  await ownerPool.query(
    `INSERT INTO invoice_formats (tenant_id, invoice_id, kind, content_type, body_text, byte_size)
     VALUES ($1, $2, 'ubl', 'application/xml', '<Invoice/>', 10)`,
    [tenantId, id],
  )
  return id
}

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
    invoiceA = await seedInvoice(ownerPool, tenantA, 'FA-A-1')
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
    const hash = await hashPassword('super-admin-passphrase-1')
    await ownerPool.query(
      "INSERT INTO platform_admins (email, password_hash) VALUES ('root@factelec.fr', $1)",
      [hash],
    )
    const login = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'super-admin-passphrase-1' })
      .expect(200)
    const adminCookie = login.headers['set-cookie'] as unknown as string[]
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
