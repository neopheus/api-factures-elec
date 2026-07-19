import { createHmac } from 'node:crypto'
import { MODULE_METADATA } from '@nestjs/common/constants.js'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import {
  BILLING_PORT,
  BillingDisabledError,
  BillingSignatureError,
} from '../../src/billing/billing.port.js'
import { BillingPortModule } from '../../src/billing/billing-port.module.js'
import { FakeBillingDriver } from '../../src/billing/fake-billing.driver.js'
import { NoneBillingDriver } from '../../src/billing/none-billing.driver.js'
import { StripeBillingDriver } from '../../src/billing/stripe-billing.driver.js'

describe('FakeBillingDriver', () => {
  it('ensureCustomer est idempotent par tenant', async () => {
    const fake = new FakeBillingDriver()
    const meta = {
      tenantId: 't-1',
      name: 'Org',
      siren: '123456789',
      email: 'o@ex.com',
    }
    const a = await fake.ensureCustomer(meta)
    const b = await fake.ensureCustomer(meta)
    expect(a).toBe(b)
    expect(a).toMatch(/^cus_fake_/)
  })

  it('createCheckoutSession/createPortalSession renvoient des URLs déterministes', async () => {
    const fake = new FakeBillingDriver()
    const cus = await fake.ensureCustomer({
      tenantId: 't-1',
      name: 'Org',
      siren: '123456789',
      email: 'o@ex.com',
    })
    const checkout = await fake.createCheckoutSession(
      cus,
      'http://ok',
      'http://ko',
    )
    expect(checkout).toContain('checkout')
    const portal = await fake.createPortalSession(cus, 'http://back')
    expect(portal).toContain('portal')
  })

  it('constructWebhookEvent vérifie la signature HMAC et normalise', () => {
    const fake = new FakeBillingDriver()
    const body = Buffer.from(
      JSON.stringify({
        customerId: 'cus_fake_t-1',
        occurredAt: '2026-07-19T00:00:00.000Z',
        subscriptionId: 'sub_fake_1',
        status: 'active',
        currentPeriodEnd: '2026-08-19T00:00:00.000Z',
      }),
    )
    const evt = fake.constructWebhookEvent(body, FakeBillingDriver.sign(body))
    expect(evt.customerId).toBe('cus_fake_t-1')
    expect(evt.status).toBe('active')
    expect(evt.occurredAt).toEqual(new Date('2026-07-19T00:00:00.000Z'))
  })

  it('constructWebhookEvent normalise currentPeriodEnd absent en null (événement sans période, ex. customer.created)', () => {
    const fake = new FakeBillingDriver()
    const body = Buffer.from(
      JSON.stringify({
        customerId: null,
        occurredAt: '2026-07-19T00:00:00.000Z',
        subscriptionId: null,
        status: null,
        currentPeriodEnd: null,
      }),
    )
    const evt = fake.constructWebhookEvent(body, FakeBillingDriver.sign(body))
    expect(evt.customerId).toBeNull()
    expect(evt.status).toBeNull()
    expect(evt.currentPeriodEnd).toBeNull()
  })

  it('constructWebhookEvent rejette une signature invalide', () => {
    const fake = new FakeBillingDriver()
    const body = Buffer.from('{}')
    const bad = createHmac('sha256', 'wrong').update(body).digest('hex')
    expect(() => fake.constructWebhookEvent(body, bad)).toThrow(
      BillingSignatureError,
    )
  })

  it('reportUsage accumule (observable pour les tests aval)', async () => {
    const fake = new FakeBillingDriver()
    await fake.reportUsage([
      { customerId: 'cus_fake_t-1', day: '2026-07-18', count: 3 },
    ])
    expect(fake.reported).toEqual([
      { customerId: 'cus_fake_t-1', day: '2026-07-18', count: 3 },
    ])
  })
})

describe('NoneBillingDriver', () => {
  it.each([
    ['ensureCustomer'],
    ['createCheckoutSession'],
    ['createPortalSession'],
    ['reportUsage'],
  ] as const)('%s → BillingDisabledError', async (method) => {
    const none = new NoneBillingDriver()
    // biome-ignore lint/suspicious/noExplicitAny: dispatch générique de test
    await expect((none as any)[method]()).rejects.toThrow(BillingDisabledError)
  })

  it('constructWebhookEvent → BillingDisabledError (synchrone)', () => {
    const none = new NoneBillingDriver()
    expect(() => none.constructWebhookEvent(Buffer.from(''), 'x')).toThrow(
      BillingDisabledError,
    )
  })
})

describe('StripeBillingDriver (squelette Task 3 — implémentation Task 4)', () => {
  it('chaque méthode throw explicitement "non implémenté (Task 4)"', async () => {
    const stripe = new StripeBillingDriver(
      'sk_test_x',
      'whsec_x',
      'price_base',
      'price_metered',
    )
    await expect(
      stripe.ensureCustomer({
        tenantId: 't-1',
        name: 'Org',
        siren: '123456789',
        email: 'o@ex.com',
      }),
    ).rejects.toThrow('non implémenté (Task 4)')
    await expect(
      stripe.createCheckoutSession('cus_x', 'http://ok', 'http://ko'),
    ).rejects.toThrow('non implémenté (Task 4)')
    await expect(
      stripe.createPortalSession('cus_x', 'http://back'),
    ).rejects.toThrow('non implémenté (Task 4)')
    await expect(stripe.reportUsage([])).rejects.toThrow(
      'non implémenté (Task 4)',
    )
    expect(() => stripe.constructWebhookEvent(Buffer.from(''), 'x')).toThrow(
      'non implémenté (Task 4)',
    )
  })
})

// `billing-port.module.ts` est exclu de la couverture globale
// (`**/*.module.ts`, cf. vitest.config.ts) — pur câblage DI. On extrait
// néanmoins le factory du provider BILLING_PORT via les métadonnées Nest
// (mêmes clés que le décorateur @Module) pour PROUVER la sélection de
// driver et le fail-fast 'stripe' sans avoir à démarrer un module Nest
// complet (calque consent-signature.module.test.ts, 3.5).
function fakeConfig(
  values: Record<string, unknown>,
): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    never,
    true
  >
}

function getBillingFactory() {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    BillingPortModule,
  ) as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => unknown
  }>
  const provider = providers.find((p) => p.provide === BILLING_PORT)
  if (!provider)
    throw new Error('BILLING_PORT provider not found on BillingPortModule')
  return provider.useFactory
}

describe('BillingPortModule BILLING_PORT factory', () => {
  it("'none' → NoneBillingDriver", () => {
    const factory = getBillingFactory()
    const driver = factory(fakeConfig({ BILLING_DRIVER: 'none' }))
    expect(driver).toBeInstanceOf(NoneBillingDriver)
  })

  it("'fake' → FakeBillingDriver", () => {
    const factory = getBillingFactory()
    const driver = factory(fakeConfig({ BILLING_DRIVER: 'fake' }))
    expect(driver).toBeInstanceOf(FakeBillingDriver)
  })

  it("'stripe' sans clés → throw explicite mentionnant STRIPE_SECRET_KEY", () => {
    const factory = getBillingFactory()
    expect(() => factory(fakeConfig({ BILLING_DRIVER: 'stripe' }))).toThrow(
      /STRIPE_SECRET_KEY/,
    )
  })

  it("'stripe' avec les 4 clés → StripeBillingDriver", () => {
    const factory = getBillingFactory()
    const driver = factory(
      fakeConfig({
        BILLING_DRIVER: 'stripe',
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        STRIPE_PRICE_BASE: 'price_base',
        STRIPE_PRICE_METERED: 'price_metered',
      }),
    )
    expect(driver).toBeInstanceOf(StripeBillingDriver)
  })
})
