// Effet de bord OBLIGATOIRE en première position (cf. helpers/billing-fake-env.ts).
import './helpers/billing-fake-env.js'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { BillingRepository } from '../../src/billing/billing.repository.js'
import { FakeBillingDriver } from '../../src/billing/fake-billing.driver.js'
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
    // `rawBody: true` : requis par POST /billing/webhook (vérification de
    // signature Stripe sur le corps brut, cf. main.ts) — opt-in du harnais
    // e2e, motif documenté dans helpers/app.ts.
    app = await createTestApp(db.appUrl, undefined, { rawBody: true })
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

  // Task 7 : POST /billing/webhook — AUCUN cookie de session sur aucune de
  // ces requêtes (preuve que l'authenticité repose sur la signature, pas sur
  // la session ; `cookie`/`csrf` restent réservés aux GET /billing/status de
  // vérification). `FakeBillingDriver.sign` signe les octets BRUTS envoyés
  // (motif fake-billing.driver.ts) — `postWebhook` ci-dessous poste ce
  // `Buffer` avec un sérialiseur passe-plat (`.serialize((body) => body)`) :
  // par défaut, superagent sérialise TOUJOURS `.send(buffer)` avec
  // `JSON.stringify` dès que le Content-Type est `application/json` (y
  // compris un `Buffer`, dont `JSON.stringify` produit `{"type":"Buffer",
  // "data":[...]}` — vérifié empiriquement), ce qui romprait la signature
  // calculée sur les octets bruts.
  describe('POST /billing/webhook (signature Stripe, sans session)', () => {
    function signedWebhookBody(payload: Record<string, unknown>): {
      raw: Buffer
      signature: string
    } {
      const raw = Buffer.from(JSON.stringify(payload))
      return { raw, signature: FakeBillingDriver.sign(raw) }
    }

    function postWebhook(raw: Buffer, signature: string) {
      return request(app.getHttpServer())
        .post('/billing/webhook')
        .set('stripe-signature', signature)
        .type('json')
        .serialize((body) => body)
        .send(raw)
    }

    it('événement signé pour le customer déjà attaché → 200, le miroir reflète le nouvel événement', async () => {
      const { raw, signature } = signedWebhookBody({
        customerId: `cus_fake_${tenantId}`,
        occurredAt: '2026-07-19T13:00:00.000Z', // postérieur au dernier événement appliqué (10:00)
        subscriptionId: 'sub_e2e_webhook',
        status: 'active',
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
      })

      await postWebhook(raw, signature).expect(200, { received: true })

      const status = await request(app.getHttpServer())
        .get('/billing/status')
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body).toEqual({
        status: 'active',
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        hasCustomer: true,
      })
    })

    it('signature invalide → 400 sans détail, aucun effet sur le miroir', async () => {
      const { raw } = signedWebhookBody({
        customerId: `cus_fake_${tenantId}`,
        occurredAt: '2026-07-19T14:00:00.000Z',
        subscriptionId: 'sub_bad_sig',
        status: 'canceled',
        currentPeriodEnd: null,
      })

      // Même longueur qu'une signature hex sha256 (64 caractères) mais
      // fausse — exerce la comparaison `timingSafeEqual`, pas le rejet par
      // longueur différente.
      const res = await postWebhook(raw, 'a'.repeat(64)).expect(400)
      expect(res.body).toEqual({
        type: 'urn:factelec:problem:validation-error',
        title: 'Bad request',
        status: 400,
      })

      const status = await request(app.getHttpServer())
        .get('/billing/status')
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body.status).toBe('active') // inchangé (événement rejeté avant toute écriture)
    })

    it('événement antérieur (occurredAt plus vieux) statut canceled → 200 mais le miroir reste inchangé (anti-réordonnancement)', async () => {
      const { raw, signature } = signedWebhookBody({
        customerId: `cus_fake_${tenantId}`,
        occurredAt: '2026-07-19T09:00:00.000Z', // antérieur au dernier événement appliqué (13:00)
        subscriptionId: 'sub_stale',
        status: 'canceled',
        currentPeriodEnd: null,
      })

      await postWebhook(raw, signature).expect(200, { received: true })

      const status = await request(app.getHttpServer())
        .get('/billing/status')
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body).toEqual({
        status: 'active',
        currentPeriodEnd: '2026-09-19T00:00:00.000Z',
        hasCustomer: true,
      })
    })

    it('événement sans clé currentPeriodEnd (ex. invoice.paid côté Stripe) → 200, le miroir PRÉSERVE la période existante (amendement A1)', async () => {
      const { raw, signature } = signedWebhookBody({
        customerId: `cus_fake_${tenantId}`,
        occurredAt: '2026-07-19T15:00:00.000Z', // postérieur au dernier événement appliqué (13:00)
        subscriptionId: 'sub_e2e_webhook',
        status: 'active',
        // currentPeriodEnd volontairement ABSENT du JSON (non "null" — la clé
        // n'existe pas du tout, cf. FakeBillingDriver tri-état).
      })

      await postWebhook(raw, signature).expect(200, { received: true })

      const status = await request(app.getHttpServer())
        .get('/billing/status')
        .set('Cookie', cookie)
        .expect(200)
      expect(status.body).toEqual({
        status: 'active',
        currentPeriodEnd: '2026-09-19T00:00:00.000Z', // PRÉSERVÉ, pas écrasé à null
        hasCustomer: true,
      })
    })
  })
})
