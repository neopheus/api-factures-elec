import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  type BillingCustomerMeta,
  type BillingPort,
  BillingSignatureError,
  type BillingUsageEvent,
  type BillingWebhookEvent,
} from './billing.port.js'

const FAKE_SECRET = 'whsec_fake'

// Driver en mémoire, déterministe — tests unit/e2e ET dev interactif sans
// compte Stripe. Le customer est dérivé du tenantId (idempotence naturelle).
export class FakeBillingDriver implements BillingPort {
  private readonly customers = new Map<string, string>()
  readonly reported: BillingUsageEvent[] = []

  static sign(rawBody: Buffer): string {
    return createHmac('sha256', FAKE_SECRET).update(rawBody).digest('hex')
  }

  async ensureCustomer(meta: BillingCustomerMeta): Promise<string> {
    const existing = this.customers.get(meta.tenantId)
    if (existing) return existing
    const id = `cus_fake_${meta.tenantId}`
    this.customers.set(meta.tenantId, id)
    return id
  }

  async createCheckoutSession(
    customerId: string,
    successUrl: string,
    _cancelUrl: string,
  ): Promise<string> {
    return `https://fake.stripe.local/checkout/${customerId}?success=${encodeURIComponent(successUrl)}`
  }

  async createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<string> {
    return `https://fake.stripe.local/portal/${customerId}?return=${encodeURIComponent(returnUrl)}`
  }

  async reportUsage(events: BillingUsageEvent[]): Promise<void> {
    this.reported.push(...events)
  }

  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): BillingWebhookEvent {
    const expected = FakeBillingDriver.sign(rawBody)
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(signature, 'hex')
    // timingSafeEqual exige des longueurs égales — une signature de longueur
    // différente est invalide par construction.
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new BillingSignatureError('signature invalide')
    const parsed = JSON.parse(rawBody.toString()) as {
      customerId: string | null
      occurredAt: string
      subscriptionId: string | null
      status: BillingWebhookEvent['status']
      currentPeriodEnd: string | null
    }
    return {
      customerId: parsed.customerId,
      occurredAt: new Date(parsed.occurredAt),
      subscriptionId: parsed.subscriptionId,
      status: parsed.status,
      currentPeriodEnd: parsed.currentPeriodEnd
        ? new Date(parsed.currentPeriodEnd)
        : null,
    }
  }
}
