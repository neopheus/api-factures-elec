import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { BillingSignatureError } from '../../src/billing/billing.port.js'
import { StripeBillingDriver } from '../../src/billing/stripe-billing.driver.js'

// PAS de vi.mock('stripe') dans ce fichier : on veut le VRAI SDK pour
// `constructEvent`/`generateTestHeaderString` — la vérification de
// signature HMAC est purement locale (aucun appel réseau), donc utiliser le
// SDK réel ici teste le comportement exact de production sans rien mocker.
const WEBHOOK_SECRET = 'whsec_test_fake'

function driver(): StripeBillingDriver {
  return new StripeBillingDriver(
    'sk_test_fake',
    WEBHOOK_SECRET,
    'price_base',
    'price_metered',
  )
}

describe('StripeBillingDriver.constructWebhookEvent — signature réelle (zéro réseau)', () => {
  it('signature valide → normalise le payload customer.subscription.updated', () => {
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      created: 1786060800,
      data: {
        object: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'active',
          current_period_end: 1788739200,
        },
      },
    })
    const rawBody = Buffer.from(payload)
    const stripeForSigning = new Stripe('sk_test_fake')
    const signature = stripeForSigning.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    })

    const evt = driver().constructWebhookEvent(rawBody, signature)

    expect(evt).toEqual({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      status: 'active',
      occurredAt: new Date(1786060800 * 1000),
      currentPeriodEnd: new Date(1788739200 * 1000),
    })
  })

  it('signature falsifiée → BillingSignatureError', () => {
    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'customer.subscription.updated',
      created: 1786060800,
      data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active' } },
    })
    const rawBody = Buffer.from(payload)
    const stripeForSigning = new Stripe('sk_test_fake')
    // Signée avec un secret DIFFÉRENT de celui du driver → invalide.
    const signature = stripeForSigning.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_wrong',
    })

    expect(() => driver().constructWebhookEvent(rawBody, signature)).toThrow(
      BillingSignatureError,
    )
  })
})
