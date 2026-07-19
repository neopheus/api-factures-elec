// Effet de bord OBLIGATOIRE en première position (cf. helpers/billing-fake-env.ts).
import './helpers/billing-fake-env.js'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { BillingRepository } from '../../src/billing/billing.repository.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { extractCookie } from './helpers/session.js'

// Endpoints checkout/portal/status (Task 6, plan phase 5) — suite LIGHT
// (Postgres seul, aucun Worker BullMQ/Redis, motif billing-persistence.e2e) :
// `BILLING_DRIVER=fake` posé par helpers/billing-fake-env.ts AVANT le
// chargement d'AppModule. Session UNIQUEMENT (owner|admin) + CSRF sur les 2
// POST, motif lifecycle.e2e.test.ts (signup/cookie/csrf).
describe('billing checkout/portal/status endpoints (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let repo: BillingRepository
  let tenantId: string
  let cookie: string[]
  let csrf: string

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
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    repo = new BillingRepository(new TenantContextService(appPool), appPool)
    app = await createTestApp(db.appUrl)
    ;({ tenantId, cookie, csrf } = await signup(
      'owner@billing.ex',
      'Org Billing',
    ))
  })
  afterAll(async () => {
    await app.close()
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('rejects a request without a session → 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/billing/status')
      .expect(401)
    expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
  })

  it('forbids a viewer role → 403', async () => {
    await ownerPool.query(
      "INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, 'viewer@billing.ex', $2, 'viewer')",
      [tenantId, await hashPassword('a-strong-password-1')],
    )
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'viewer@billing.ex', password: 'a-strong-password-1' })
      .expect(200)
    const vset = login.headers['set-cookie'] as unknown as string[]

    const res = await request(app.getHttpServer())
      .get('/billing/status')
      .set('Cookie', vset)
      .expect(403)
    expect(res.body.type).toBe('urn:factelec:problem:forbidden')
  })

  it('rejects a session mutation without the CSRF header → 403', async () => {
    await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .set('Cookie', cookie)
      .expect(403)
  })

  it('portal before any checkout → 409 (no Stripe customer yet)', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/portal-session')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .expect(409)
    expect(res.body.type).toBe('urn:factelec:problem:conflict')
  })

  it('status starts at none (no Stripe customer, no subscription)', async () => {
    const res = await request(app.getHttpServer())
      .get('/billing/status')
      .set('Cookie', cookie)
      .expect(200)
    expect(res.body).toEqual({
      status: 'none',
      currentPeriodEnd: null,
      hasCustomer: false,
    })
  })

  it('checkout creates a Stripe customer (fake driver) and returns a checkout URL → 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .expect(201)
    expect(res.body.url).toContain('checkout')

    // Status reflète maintenant hasCustomer (miroir attachCustomer) mais
    // reste `none` : aucun événement webhook n'a encore été appliqué.
    const status = await request(app.getHttpServer())
      .get('/billing/status')
      .set('Cookie', cookie)
      .expect(200)
    expect(status.body).toEqual({
      status: 'none',
      currentPeriodEnd: null,
      hasCustomer: true,
    })
  })

  it('portal now returns a portal URL (customer attached by the previous checkout) → 201', async () => {
    const res = await request(app.getHttpServer())
      .post('/billing/portal-session')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .expect(201)
    expect(res.body.url).toContain('portal')
  })

  it('status reflects an active subscription after a direct repo applyEvent (webhook mirror)', async () => {
    await repo.applyEvent(tenantId, {
      customerId: `cus_fake_${tenantId}`,
      occurredAt: new Date('2026-07-19T10:00:00Z'),
      subscriptionId: 'sub_e2e',
      status: 'active',
      currentPeriodEnd: new Date('2026-08-19T00:00:00Z'),
    })

    const res = await request(app.getHttpServer())
      .get('/billing/status')
      .set('Cookie', cookie)
      .expect(200)
    expect(res.body).toEqual({
      status: 'active',
      currentPeriodEnd: '2026-08-19T00:00:00.000Z',
      hasCustomer: true,
    })
  })
})
