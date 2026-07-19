import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BillingSignatureError } from '../../src/billing/billing.port.js'
import { StripeBillingDriver } from '../../src/billing/stripe-billing.driver.js'

// SDK Stripe entièrement mocké ici — zéro réseau. Chaque méthode utilisée
// par le driver est un vi.fn() dédié, partagé entre les tests via les
// closures ci-dessous et réinitialisé dans beforeEach.
const customersSearch = vi.fn()
const customersCreate = vi.fn()
const checkoutSessionsCreate = vi.fn()
const billingPortalSessionsCreate = vi.fn()
const meterEventsCreate = vi.fn()
const webhooksConstructEvent = vi.fn()

vi.mock('stripe', () => ({
  // `__esModule: true` : le SDK réel est un module CJS sans ce marqueur, et
  // l'interop `import Stripe from 'stripe'` s'appuie dessus pour savoir
  // s'il faut déballer `.default`.
  __esModule: true,
  // IMPORTANT : `function`, pas une arrow function — le driver fait
  // `new Stripe(secretKey)`, et Vitest exige que l'implémentation d'un
  // vi.fn() constructible soit déclarée avec `function`/`class` (une arrow
  // function n'est jamais constructible en JS, `new` échoue sinon avec
  // "is not a constructor").
  default: vi.fn().mockImplementation(function StripeMock() {
    return {
      customers: { search: customersSearch, create: customersCreate },
      checkout: { sessions: { create: checkoutSessionsCreate } },
      billingPortal: { sessions: { create: billingPortalSessionsCreate } },
      billing: { meterEvents: { create: meterEventsCreate } },
      webhooks: { constructEvent: webhooksConstructEvent },
    }
  }),
}))

function makeDriver(): StripeBillingDriver {
  return new StripeBillingDriver(
    'sk_test_x',
    'whsec_x',
    'price_base',
    'price_metered',
  )
}

// Construit un Stripe.Event minimal — seuls les champs lus par
// normalizeEvent sont renseignés, le reste est hors-sujet pour ces tests
// (le SDK réel les type mais notre driver ne les consomme pas).
function fakeEvent(partial: {
  id?: string
  type: Stripe.Event['type']
  created?: number
  object: Record<string, unknown>
}): Stripe.Event {
  return {
    id: partial.id ?? 'evt_x',
    object: 'event',
    api_version: null,
    created: partial.created ?? 1786060800,
    data: { object: partial.object },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    type: partial.type,
    // biome-ignore lint/suspicious/noExplicitAny: fixture de test, pas le code du driver
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('StripeBillingDriver.ensureCustomer', () => {
  const meta = {
    tenantId: 't-1',
    name: 'Org',
    siren: '123456789',
    email: 'o@ex.com',
  }

  it('renvoie le customer trouvé par recherche metadata tenant_id sans créer', async () => {
    customersSearch.mockResolvedValue({ data: [{ id: 'cus_found' }] })
    const driver = makeDriver()

    const id = await driver.ensureCustomer(meta)

    expect(id).toBe('cus_found')
    expect(customersSearch).toHaveBeenCalledWith({
      query: "metadata['tenant_id']:'t-1'",
    })
    expect(customersCreate).not.toHaveBeenCalled()
  })

  it('crée un customer avec metadata tenant_id/siren si la recherche ne trouve rien', async () => {
    customersSearch.mockResolvedValue({ data: [] })
    customersCreate.mockResolvedValue({ id: 'cus_created' })
    const driver = makeDriver()

    const id = await driver.ensureCustomer(meta)

    expect(id).toBe('cus_created')
    expect(customersCreate).toHaveBeenCalledWith({
      name: 'Org',
      email: 'o@ex.com',
      metadata: { tenant_id: 't-1', siren: '123456789' },
    })
  })
})

describe('StripeBillingDriver.createCheckoutSession', () => {
  it('crée une session subscription avec les deux price (base + metered) et renvoie son url', async () => {
    checkoutSessionsCreate.mockResolvedValue({ url: 'https://checkout/1' })
    const driver = makeDriver()

    const url = await driver.createCheckoutSession(
      'cus_1',
      'http://ok',
      'http://ko',
    )

    expect(url).toBe('https://checkout/1')
    expect(checkoutSessionsCreate).toHaveBeenCalledWith({
      mode: 'subscription',
      customer: 'cus_1',
      line_items: [
        { price: 'price_base', quantity: 1 },
        { price: 'price_metered' },
      ],
      success_url: 'http://ok',
      cancel_url: 'http://ko',
    })
  })

  it('throw explicitement si Stripe renvoie url: null', async () => {
    checkoutSessionsCreate.mockResolvedValue({ url: null })
    const driver = makeDriver()

    await expect(
      driver.createCheckoutSession('cus_1', 'http://ok', 'http://ko'),
    ).rejects.toThrow(/url/i)
  })
})

describe('StripeBillingDriver.createPortalSession', () => {
  it('crée une session portail et renvoie son url', async () => {
    billingPortalSessionsCreate.mockResolvedValue({
      url: 'https://portal/1',
    })
    const driver = makeDriver()

    const url = await driver.createPortalSession('cus_1', 'http://back')

    expect(url).toBe('https://portal/1')
    expect(billingPortalSessionsCreate).toHaveBeenCalledWith({
      customer: 'cus_1',
      return_url: 'http://back',
    })
  })
})

describe('StripeBillingDriver.reportUsage', () => {
  it('émet un meterEvents.create PAR événement, avec identifier customerId-day', async () => {
    meterEventsCreate.mockResolvedValue({})
    const driver = makeDriver()

    await driver.reportUsage([
      { customerId: 'cus_1', day: '2026-07-18', count: 3 },
      { customerId: 'cus_2', day: '2026-07-19', count: 5 },
    ])

    expect(meterEventsCreate).toHaveBeenCalledTimes(2)
    expect(meterEventsCreate).toHaveBeenNthCalledWith(1, {
      event_name: 'documents_processed',
      identifier: 'cus_1-2026-07-18',
      payload: { stripe_customer_id: 'cus_1', value: '3' },
    })
    expect(meterEventsCreate).toHaveBeenNthCalledWith(2, {
      event_name: 'documents_processed',
      identifier: 'cus_2-2026-07-19',
      payload: { stripe_customer_id: 'cus_2', value: '5' },
    })
  })

  it('reste no-op sans appel Stripe si la liste est vide', async () => {
    const driver = makeDriver()
    await driver.reportUsage([])
    expect(meterEventsCreate).not.toHaveBeenCalled()
  })
})

describe('StripeBillingDriver.constructWebhookEvent — normalisation (SDK mocké)', () => {
  it.each([
    ['incomplete_expired', 'canceled'],
    ['paused', 'unpaid'],
    ['trialing', 'trialing'],
    ['past_due', 'past_due'],
    ['active', 'active'],
    ['unpaid', 'unpaid'],
    ['canceled', 'canceled'],
    ['incomplete', 'incomplete'],
    // Statut Stripe non reconnu (ex. ajouté par une future version d'API que
    // ce SDK ne connaît pas encore) → 'unpaid', conservateur : bloque plutôt
    // que de laisser passer un client dont le vrai statut est inconnu.
    ['some_future_status', 'unpaid'],
  ] as const)(
    'customer.subscription.updated statut Stripe %s → %s',
    async (stripeStatus, expected) => {
      webhooksConstructEvent.mockReturnValue(
        fakeEvent({
          type: 'customer.subscription.updated',
          object: {
            id: 'sub_1',
            customer: 'cus_1',
            status: stripeStatus,
            current_period_end: 1788739200,
          },
        }),
      )
      const driver = makeDriver()

      const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

      expect(evt.status).toBe(expected)
      expect(evt.customerId).toBe('cus_1')
      expect(evt.subscriptionId).toBe('sub_1')
      expect(evt.currentPeriodEnd).toEqual(new Date(1788739200 * 1000))
    },
  )

  it('customer.subscription.updated SANS current_period_end top-level mais AVEC items.data[0].current_period_end → fallback (amendement A1)', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'customer.subscription.updated',
        object: {
          id: 'sub_items_1',
          customer: 'cus_items_1',
          status: 'active',
          items: { data: [{ current_period_end: 1788739200 }] },
        },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.currentPeriodEnd).toEqual(new Date(1788739200 * 1000))
  })

  it('customer.subscription.updated avec current_period_end top-level ET items.data[0].current_period_end → le top-level est PRIORITAIRE (compat legacy)', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'customer.subscription.updated',
        object: {
          id: 'sub_items_2',
          customer: 'cus_items_2',
          status: 'active',
          current_period_end: 1788739200,
          items: { data: [{ current_period_end: 1800000000 }] },
        },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.currentPeriodEnd).toEqual(new Date(1788739200 * 1000))
  })

  it('customer.subscription.updated sans AUCUNE source de période (ni top-level, ni items.data) → null (porté-vide)', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'customer.subscription.updated',
        object: {
          id: 'sub_items_3',
          customer: 'cus_items_3',
          status: 'active',
          items: { data: [] },
        },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.currentPeriodEnd).toBeNull()
  })

  it('customer.subscription.created → même normalisation que updated', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'customer.subscription.created',
        object: { id: 'sub_2', customer: 'cus_2', status: 'trialing' },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.status).toBe('trialing')
    expect(evt.subscriptionId).toBe('sub_2')
    expect(evt.currentPeriodEnd).toBeNull()
  })

  it('customer.subscription.deleted → status canceled quel que soit le statut Stripe porté', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'customer.subscription.deleted',
        object: { id: 'sub_3', customer: 'cus_3', status: 'active' },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.status).toBe('canceled')
    expect(evt.customerId).toBe('cus_3')
  })

  it("customer.subscription.* gère un customer développé (objet) plutôt qu'un id", () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'customer.subscription.updated',
        object: {
          id: 'sub_4',
          customer: { id: 'cus_expanded', object: 'customer' },
          status: 'active',
        },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.customerId).toBe('cus_expanded')
  })

  it('checkout.session.completed → status active, subscriptionId depuis data.object.subscription', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'checkout.session.completed',
        object: { customer: 'cus_5', subscription: 'sub_5' },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.status).toBe('active')
    expect(evt.customerId).toBe('cus_5')
    expect(evt.subscriptionId).toBe('sub_5')
    // undefined (amendement A1) : checkout.session.completed ne porte pas la
    // période — applyEvent doit PRÉSERVER le miroir, pas l'écraser à null.
    expect(evt.currentPeriodEnd).toBeUndefined()
  })

  it("checkout.session.completed gère une subscription développée (objet) plutôt qu'un id", () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'checkout.session.completed',
        object: {
          customer: 'cus_5b',
          subscription: { id: 'sub_expanded', object: 'subscription' },
        },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.subscriptionId).toBe('sub_expanded')
  })

  it('checkout.session.completed avec subscription: null → subscriptionId null', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'checkout.session.completed',
        object: { customer: 'cus_6', subscription: null },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.subscriptionId).toBeNull()
  })

  it('invoice.paid → status active', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'invoice.paid',
        object: {
          customer: 'cus_7',
          parent: {
            type: 'subscription_details',
            subscription_details: { subscription: 'sub_7' },
          },
        },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.status).toBe('active')
    expect(evt.customerId).toBe('cus_7')
    expect(evt.subscriptionId).toBe('sub_7')
    // undefined (amendement A1), même motif que checkout.session.completed.
    expect(evt.currentPeriodEnd).toBeUndefined()
  })

  it('invoice.payment_failed → status past_due, subscriptionId null si absent', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'invoice.payment_failed',
        object: { customer: 'cus_8', parent: null },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.status).toBe('past_due')
    expect(evt.subscriptionId).toBeNull()
    // undefined (amendement A1), même motif que checkout.session.completed.
    expect(evt.currentPeriodEnd).toBeUndefined()
  })

  it('type non consommé (payment_intent.created) → status null, customerId extrait si string', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({
        type: 'payment_intent.created',
        object: { customer: 'cus_9' },
      }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.status).toBeNull()
    expect(evt.customerId).toBe('cus_9')
    expect(evt.subscriptionId).toBeNull()
    // undefined (amendement A1) : cohérent avec status: null, jamais
    // appliqué par applyEvent (garde défensive).
    expect(evt.currentPeriodEnd).toBeUndefined()
  })

  it('type non consommé sans customer → customerId null', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({ type: 'payment_intent.created', object: {} }),
    )
    const driver = makeDriver()

    const evt = driver.constructWebhookEvent(Buffer.from('{}'), 'sig')

    expect(evt.customerId).toBeNull()
  })

  it('délègue signature/secret/rawBody à stripe.webhooks.constructEvent', () => {
    webhooksConstructEvent.mockReturnValue(
      fakeEvent({ type: 'payment_intent.created', object: {} }),
    )
    const driver = makeDriver()
    const rawBody = Buffer.from('{"id":"evt_1"}')

    driver.constructWebhookEvent(rawBody, 'sig_abc')

    expect(webhooksConstructEvent).toHaveBeenCalledWith(
      rawBody,
      'sig_abc',
      'whsec_x',
    )
  })

  it("relance BillingSignatureError (jamais l'erreur SDK brute) si constructEvent throw", () => {
    webhooksConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature')
    })
    const driver = makeDriver()

    expect(() =>
      driver.constructWebhookEvent(Buffer.from('{}'), 'sig_bad'),
    ).toThrow(BillingSignatureError)
  })
})
