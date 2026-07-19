import {
  type BillingCustomerMeta,
  BillingDisabledError,
  type BillingPort,
  type BillingUsageEvent,
  type BillingWebhookEvent,
} from './billing.port.js'

const DISABLED = 'billing désactivé (BILLING_DRIVER=none)'

// Neutre : tout usage actif échoue explicitement — le service traduit en
// 503 problem-details ; le garde, lui, ne passe JAMAIS par le port.
//
// Signatures alignées explicitement sur BillingPort (plutôt que des méthodes
// sans paramètres) : `implements` accepterait une arité moindre par
// bivariance de méthode, mais un appel direct et typé (hors dispatch `any`
// de test) sur une signature 0-arg échoue alors à la compilation — piège
// détecté par `tsc --noEmit` sur le test `constructWebhookEvent`.
export class NoneBillingDriver implements BillingPort {
  async ensureCustomer(_meta: BillingCustomerMeta): Promise<string> {
    throw new BillingDisabledError(DISABLED)
  }
  async createCheckoutSession(
    _customerId: string,
    _successUrl: string,
    _cancelUrl: string,
  ): Promise<string> {
    throw new BillingDisabledError(DISABLED)
  }
  async createPortalSession(
    _customerId: string,
    _returnUrl: string,
  ): Promise<string> {
    throw new BillingDisabledError(DISABLED)
  }
  async reportUsage(_events: BillingUsageEvent[]): Promise<void> {
    throw new BillingDisabledError(DISABLED)
  }
  constructWebhookEvent(
    _rawBody: Buffer,
    _signature: string,
  ): BillingWebhookEvent {
    throw new BillingDisabledError(DISABLED)
  }
}
