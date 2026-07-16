import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { extractCookie } from './helpers/session.js'

const invoiceInput: InvoiceInput = {
  number: 'FA-EP-1',
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
      vatRate: '20.00',
    },
  ],
}

describe('invoice lifecycle transitions (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let repo: InvoicesRepository
  let tenantId: string
  let cookie: string[]
  let csrf: string
  let invoiceId: string

  async function signup(email: string, organizationName: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, password: 'a-strong-password-1', organizationName })
      .expect(201)
    const set = res.headers['set-cookie'] as unknown as string[]
    return {
      tenantId: res.body.user.tenantId as string,
      cookie: set,
      csrf: extractCookie(set, 'factelec_csrf'),
    }
  }

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    repo = new InvoicesRepository(new TenantContextService(ownerPool as never))
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
    ;({ tenantId, cookie, csrf } = await signup('owner@ex.com', 'Org A'))
    // Facture posée directement dans le tenant du user (statut initial deposee).
    ;({ id: invoiceId } = await repo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput),
    ))
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  const post = (id: string, body: object) =>
    request(app.getHttpServer())
      .post(`/invoices/${id}/status`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send(body)

  it('records a valid forward transition (deposee → prise_en_charge)', async () => {
    // Sous la matrice DAG (Task 1, plan 3.1), deposee ne va plus directement
    // à approuvee : la chronologie exige prise_en_charge d'abord (A1,
    // plan-3-1-review.md — canTransition('deposee','prise_en_charge')===true
    // est asserté par le test unitaire de lifecycle-status).
    const res = await post(invoiceId, { toStatus: 'prise_en_charge' }).expect(
      201,
    )
    expect(res.body.status).toBe('prise_en_charge')
    const hist = await request(app.getHttpServer())
      .get(`/invoices/${invoiceId}/status`)
      .set('Cookie', cookie)
      .expect(200)
    expect(hist.body.current).toBe('prise_en_charge')
    expect(
      hist.body.events.map((e: { toStatus: string }) => e.toStatus),
    ).toEqual(['deposee', 'prise_en_charge'])
  })

  it('rejects a backward transition (prise_en_charge → deposee) → 422', async () => {
    const res = await post(invoiceId, { toStatus: 'deposee' }).expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:invalid-status-transition')
  })

  it('requires a reason for refusee (G7.25) → 422 without, 201 with', async () => {
    const { id } = await repo.insertReceived(
      tenantId,
      buildInvoice({ ...invoiceInput, number: 'FA-EP-REF' }),
    )
    await post(id, { toStatus: 'refusee' }).expect(422)
    const ok = await post(id, {
      toStatus: 'refusee',
      reason: 'destinataire inconnu',
    }).expect(201)
    expect(ok.body.status).toBe('refusee')
    // terminal : plus aucune transition
    await post(id, { toStatus: 'rejetee' }).expect(422)
  })

  it('rejects an unknown status → 422 validation', async () => {
    const res = await post(invoiceId, { toStatus: 'pas-un-statut' }).expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
  })

  it('forbids a viewer from recording a transition → 403', async () => {
    // Seed d'un viewer dans le même tenant + login.
    await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'viewer@ex.com', $2, 'viewer')",
      [tenantId, await hashPassword('a-strong-password-1')],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'viewer@ex.com', password: 'a-strong-password-1' })
      .expect(200)
    const vset = login.headers['set-cookie'] as unknown as string[]
    const { id } = await repo.insertReceived(
      tenantId,
      buildInvoice({ ...invoiceInput, number: 'FA-EP-V' }),
    )
    await request(app.getHttpServer())
      .post(`/invoices/${id}/status`)
      .set('Cookie', vset)
      .set('X-CSRF-Token', extractCookie(vset, 'factelec_csrf'))
      .send({ toStatus: 'approuvee' })
      .expect(403)
  })

  it('does not leak another tenant’s invoice → 404', async () => {
    const other = await signup('owner2@ex.com', 'Org B')
    const res = await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/status`)
      .set('Cookie', other.cookie)
      .set('X-CSRF-Token', other.csrf)
      .send({ toStatus: 'approuvee' })
      .expect(404)
    expect(res.body.type).toBe('urn:factelec:problem:not-found')
  })

  it('rejects a session mutation without the CSRF header → 403', async () => {
    await request(app.getHttpServer())
      .post(`/invoices/${invoiceId}/status`)
      .set('Cookie', cookie)
      .send({ toStatus: 'encaissee' })
      .expect(403)
  })
})
