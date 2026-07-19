import type {
  BillingCustomerMeta,
  BillingPort,
  BillingUsageEvent,
  BillingWebhookEvent,
} from './billing.port.js'

// Squelette (Task 3) — implémentation SDK Stripe réelle prévue Task 4.
// Existe dès maintenant uniquement pour que BillingPortModule compile et
// puisse être testé unitairement (sélection du driver 'stripe' au
// bootstrap). Les 4 clés sont capturées en champs `protected` (lus par
// aucune méthode pour l'instant — Task 4 les consommera au câblage du SDK
// Stripe) plutôt que `private` : un champ privé jamais lu déclenche Biome
// noUnusedPrivateClassMembers, alors que le constructeur doit conserver
// cette arité 4 (le call site de BillingPortModule passe les 4 clés
// positionnellement).
export class StripeBillingDriver implements BillingPort {
  protected readonly secretKey: string
  protected readonly webhookSecret: string
  protected readonly priceBase: string
  protected readonly priceMetered: string

  constructor(
    secretKey: string,
    webhookSecret: string,
    priceBase: string,
    priceMetered: string,
  ) {
    this.secretKey = secretKey
    this.webhookSecret = webhookSecret
    this.priceBase = priceBase
    this.priceMetered = priceMetered
  }

  async ensureCustomer(_meta: BillingCustomerMeta): Promise<string> {
    throw new Error('non implémenté (Task 4)')
  }

  async createCheckoutSession(
    _customerId: string,
    _successUrl: string,
    _cancelUrl: string,
  ): Promise<string> {
    throw new Error('non implémenté (Task 4)')
  }

  async createPortalSession(
    _customerId: string,
    _returnUrl: string,
  ): Promise<string> {
    throw new Error('non implémenté (Task 4)')
  }

  async reportUsage(_events: BillingUsageEvent[]): Promise<void> {
    throw new Error('non implémenté (Task 4)')
  }

  constructWebhookEvent(
    _rawBody: Buffer,
    _signature: string,
  ): BillingWebhookEvent {
    throw new Error('non implémenté (Task 4)')
  }
}
