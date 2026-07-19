// Effet de bord OBLIGATOIRE en première position (cf.
// helpers/billing-fake-enforced-env.ts) : pose BILLING_DRIVER=fake ET
// BILLING_ENFORCEMENT=on AVANT le chargement d'AppModule.
import './helpers/billing-fake-enforced-env.js'
import { buildInvoice, type InvoiceInput } from '@factelec/invoice-core'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateApiKey } from '../../src/auth/api-key.js'
import { FakeBillingDriver } from '../../src/billing/fake-billing.driver.js'
import { TenantContextService } from '../../src/db/tenant-context.service.js'
import { InvoicesRepository } from '../../src/invoices/invoices.repository.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { extractCookie } from './helpers/session.js'

const invoiceInput: InvoiceInput = {
  number: 'FA-GUARD-SEED',
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

function postBody(number: string) {
  return {
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
  }
}

// Suite LIGHT (motif ingestion.e2e.test.ts — Postgres + Redis Testcontainers
// pour l'enfilement BullMQ producteur, AUCUN Worker/processor démarré donc
// hors HEAVY_TESTS, vérifié par heavy-suites.arch.test.ts) dédiée au garde
// d'enforcement (Task 8, plan phase 5) — BILLING_ENFORCEMENT=on posé par le
// helper importé ci-dessus, contrairement à `billing-endpoints.e2e.test.ts`
// (enforcement 'off' implicite, garde neutre).
describe('BillingGuard 402 sur les mutations d’émission (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication
  let ownerPool: pg.Pool
  let invoicesRepo: InvoicesRepository
  let tenantId: string
  let apiKeyToken: string
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
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    invoicesRepo = new InvoicesRepository(
      new TenantContextService(ownerPool as never),
    )
    // `rawBody: true` : requis par POST /billing/webhook (vérification de
    // signature Stripe sur le corps brut, motif billing-endpoints.e2e.test.ts).
    app = await createTestApp(
      db.appUrl,
      { host: redis.host, port: redis.port },
      { rawBody: true },
    )
    ;({ tenantId, cookie, csrf } = await signup(
      'owner@billing-guard.ex',
      'Org Billing Guard',
    ))

    // Clé API du MÊME tenant que la session (motif helpers/seed.ts, adapté
    // pour réutiliser le tenant créé par le signup ci-dessus plutôt que d'en
    // créer un second — le garde doit voir le même état billing des deux
    // côtés machine/session).
    const key = await generateApiKey()
    await ownerPool.query(
      'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
      [tenantId, key.prefix, key.secretHash, 'test'],
    )
    apiKeyToken = key.token

    // Rattache un customer Stripe fake (mirroir tenantBilling.stripeCustomerId
    // = cus_fake_<tenantId>) SANS activer d'abonnement (statut reste 'none')
    // — requis pour que le webhook signé plus bas puisse résoudre le tenant
    // via `findTenantByCustomer`.
    await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .expect(201)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await Promise.all([db.stop(), redis.stop()])
  })

  it('tenant sans abonnement (statut none) → POST /invoices (clé API valide) → 402 subscription-required', async () => {
    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${apiKeyToken}`)
      .send(postBody('FA-GUARD-1'))
      .expect(402)
    expect(res.body.type).toBe('urn:factelec:problem:subscription-required')
  })

  it('PENDANT le blocage : GET /invoices reste 200 (la lecture n’est jamais bloquée)', async () => {
    await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${apiKeyToken}`)
      .expect(200)
  })

  it('PENDANT le blocage : POST /invoices/:id/status (transition, session+CSRF) reste 201 (jamais bloquée)', async () => {
    // Facture posée DIRECTEMENT via le repository (contourne le POST HTTP,
    // bloqué par le garde tant que le tenant n'est pas actif) — seule la
    // transition de statut est exercée ici, motif lifecycle.e2e.test.ts.
    const { id } = await invoicesRepo.insertReceived(
      tenantId,
      buildInvoice(invoiceInput),
    )
    const res = await request(app.getHttpServer())
      .post(`/invoices/${id}/status`)
      .set('Cookie', cookie)
      .set('X-CSRF-Token', csrf)
      .send({ toStatus: 'prise_en_charge' })
      .expect(201)
    expect(res.body.status).toBe('prise_en_charge')
  })

  it('après un webhook Stripe signé faisant passer le statut à active → POST /invoices → 201', async () => {
    const raw = Buffer.from(
      JSON.stringify({
        customerId: `cus_fake_${tenantId}`,
        occurredAt: '2026-07-19T10:00:00.000Z',
        subscriptionId: 'sub_guard_e2e',
        status: 'active',
        currentPeriodEnd: '2026-08-19T00:00:00.000Z',
      }),
    )
    const signature = FakeBillingDriver.sign(raw)

    await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('stripe-signature', signature)
      .type('json')
      .serialize((body) => body)
      .send(raw)
      .expect(200, { received: true })

    const res = await request(app.getHttpServer())
      .post('/invoices')
      .set('Authorization', `Bearer ${apiKeyToken}`)
      .send(postBody('FA-GUARD-2'))
      .expect(201)
    expect(res.body.status).toBe('received')
  })
})
