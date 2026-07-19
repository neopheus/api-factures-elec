import Stripe from 'stripe'
import {
  type BillingCustomerMeta,
  type BillingPort,
  BillingSignatureError,
  type BillingSubscriptionStatus,
  type BillingUsageEvent,
  type BillingWebhookEvent,
} from './billing.port.js'

const METER_EVENT_NAME = 'documents_processed'

// Le SDK Stripe (API épinglée par ce projet, 22.3.2) ne type plus
// `current_period_end` sur Subscription — déplacé sur chaque
// SubscriptionItem par une version d'API Stripe récente (« billing periods
// per item »). Stripe continue néanmoins d'émettre ce champ historique tel
// quel dans les payloads webhook bruts (compat ascendante) : accès typé
// local plutôt qu'un cast `any` nu.
type SubscriptionWithLegacyPeriod = Stripe.Subscription & {
  current_period_end?: number
}

function extractCustomerId(
  customer:
    | string
    | Stripe.Customer
    | Stripe.DeletedCustomer
    | null
    | undefined,
): string | null {
  if (!customer) return null
  return typeof customer === 'string' ? customer : customer.id
}

function extractSubscriptionId(
  subscription: string | Stripe.Subscription | null | undefined,
): string | null {
  if (!subscription) return null
  return typeof subscription === 'string' ? subscription : subscription.id
}

function extractCurrentPeriodEnd(
  subscription: Stripe.Subscription,
): Date | null {
  const legacy = (subscription as SubscriptionWithLegacyPeriod)
    .current_period_end
  return typeof legacy === 'number' ? new Date(legacy * 1000) : null
}

function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Depuis une version d'API Stripe récente (« Invoice Subscription
  // split »), l'abonnement source d'une facture n'est plus exposé en
  // `invoice.subscription` (retiré du SDK 22.x) mais sous
  // `invoice.parent.subscription_details.subscription`.
  const subscription = invoice.parent?.subscription_details?.subscription
  return extractSubscriptionId(subscription)
}

// Driver BillingPort adossé au SDK officiel `stripe` — aucune logique
// métier ici : chaque méthode traduit un besoin du service en appel Stripe
// et normalise la réponse/le webhook vers les types du port
// (BillingWebhookEvent, BillingSubscriptionStatus) pour que le service
// reste indépendant du vocabulaire de l'API Stripe.
export class StripeBillingDriver implements BillingPort {
  private readonly stripe: Stripe
  protected readonly webhookSecret: string
  protected readonly priceBase: string
  protected readonly priceMetered: string

  constructor(
    secretKey: string,
    webhookSecret: string,
    priceBase: string,
    priceMetered: string,
  ) {
    this.stripe = new Stripe(secretKey)
    this.webhookSecret = webhookSecret
    this.priceBase = priceBase
    this.priceMetered = priceMetered
  }

  async ensureCustomer(meta: BillingCustomerMeta): Promise<string> {
    // Recherche par metadata tenant_id — un tenant a AU PLUS un customer
    // Stripe, retrouvé par sa metadata plutôt que par un id stocké
    // localement : Stripe reste la source de vérité, pas notre base.
    const found = await this.stripe.customers.search({
      query: `metadata['tenant_id']:'${meta.tenantId}'`,
    })
    const existing = found.data[0]
    if (existing) return existing.id
    const created = await this.stripe.customers.create({
      name: meta.name,
      email: meta.email,
      metadata: { tenant_id: meta.tenantId, siren: meta.siren },
    })
    return created.id
  }

  async createCheckoutSession(
    customerId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [
        { price: this.priceBase, quantity: 1 },
        { price: this.priceMetered },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
    })
    // Stripe type `url` en nullable (session encore en cours de
    // traitement) : jamais censé arriver en mode 'subscription' synchrone,
    // mais on refuse de renvoyer null silencieusement au service.
    if (!session.url)
      throw new Error(
        'Stripe checkout.sessions.create a renvoyé url: null (session inattendument incomplète)',
      )
    return session.url
  }

  async createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    })
    return session.url
  }

  async reportUsage(events: BillingUsageEvent[]): Promise<void> {
    // Séquentiel (pas Promise.all) : un meter event par jour/customer, et
    // l'identifiant `${customerId}-${day}` assure l'idempotence côté Stripe
    // (dédoublonnage sur une fenêtre glissante de 24h) — le parallélisme
    // n'apporterait rien ici et compliquerait le diagnostic d'un échec
    // partiel.
    for (const event of events) {
      await this.stripe.billing.meterEvents.create({
        event_name: METER_EVENT_NAME,
        identifier: `${event.customerId}-${event.day}`,
        payload: {
          stripe_customer_id: event.customerId,
          value: String(event.count),
        },
      })
    }
  }

  constructWebhookEvent(
    rawBody: Buffer,
    signature: string,
  ): BillingWebhookEvent {
    let event: Stripe.Event
    try {
      event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        this.webhookSecret,
      )
    } catch {
      // Ne jamais laisser fuiter l'erreur SDK brute (message/format propres
      // à Stripe) : le service ne doit connaître que le type de port.
      throw new BillingSignatureError('signature webhook Stripe invalide')
    }
    return this.normalizeEvent(event)
  }

  private normalizeEvent(event: Stripe.Event): BillingWebhookEvent {
    const occurredAt = new Date(event.created * 1000)
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        return {
          customerId: extractCustomerId(subscription.customer),
          subscriptionId: subscription.id,
          status: this.toLocalStatus(subscription.status),
          occurredAt,
          currentPeriodEnd: extractCurrentPeriodEnd(subscription),
        }
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        return {
          customerId: extractCustomerId(subscription.customer),
          subscriptionId: subscription.id,
          // Suppression = fin d'abonnement, quel que soit le statut encore
          // porté par l'objet Stripe à cet instant précis.
          status: 'canceled',
          occurredAt,
          currentPeriodEnd: extractCurrentPeriodEnd(subscription),
        }
      }
      case 'checkout.session.completed': {
        const session = event.data.object
        return {
          customerId: extractCustomerId(session.customer),
          subscriptionId: extractSubscriptionId(session.subscription),
          // Un checkout complété EST un abonnement démarré, même si Stripe
          // n'émettra le customer.subscription.created qu'ensuite.
          status: 'active',
          occurredAt,
          currentPeriodEnd: null,
        }
      }
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object
        return {
          customerId: extractCustomerId(invoice.customer),
          subscriptionId: extractInvoiceSubscriptionId(invoice),
          status: event.type === 'invoice.paid' ? 'active' : 'past_due',
          occurredAt,
          currentPeriodEnd: null,
        }
      }
      default: {
        // Type non consommé par le service (ex. payment_intent.created) :
        // normalisation a minima, le service ignore status: null. `customer`
        // n'existe pas sur toutes les ressources Stripe (ex. Account) — accès
        // typé local plutôt qu'un `any` nu sur `event.data.object` (typé
        // `{}` par le SDK pour les types d'event non discriminés ci-dessus).
        const object = event.data.object as {
          customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null
        }
        return {
          customerId: extractCustomerId(object.customer),
          subscriptionId: null,
          status: null,
          occurredAt,
          currentPeriodEnd: null,
        }
      }
    }
  }

  // Conservateur : tout statut Stripe non explicitement reconnu (ex. ajouté
  // par une version d'API future que ce SDK ne connaît pas encore) est
  // mappé à 'unpaid', qui BLOQUE l'accès côté service — mieux vaut bloquer
  // à tort un client encore payant que laisser passer un client dont on
  // ignore le vrai statut.
  private toLocalStatus(stripeStatus: string): BillingSubscriptionStatus {
    switch (stripeStatus) {
      case 'incomplete_expired':
        return 'canceled'
      case 'paused':
        return 'unpaid'
      case 'active':
      case 'trialing':
      case 'past_due':
      case 'unpaid':
      case 'canceled':
      case 'incomplete':
        return stripeStatus
      default:
        return 'unpaid'
    }
  }
}
