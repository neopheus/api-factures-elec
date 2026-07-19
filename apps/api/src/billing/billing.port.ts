// Port billing (Phase 5, spec Stripe 2026-07-19) — 6e port du projet, même
// motif que ConsentSignaturePort/CdvTransmissionPort/AnnuairePort : une
// interface stable consommée par le service, un driver par environnement
// (none/fake/stripe) sélectionné au bootstrap par BillingPortModule.
export const BILLING_PORT: unique symbol = Symbol('BILLING_PORT')

export type BillingSubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'incomplete'

export interface BillingCustomerMeta {
  tenantId: string
  name: string
  siren: string
  email: string
}

export interface BillingUsageEvent {
  customerId: string
  day: string // YYYY-MM-DD UTC
  count: number
}

// Événement webhook NORMALISÉ par le driver (le parsing spécifique Stripe
// vit dans le driver, pas dans le service).
export interface BillingWebhookEvent {
  customerId: string | null
  occurredAt: Date // event.created
  subscriptionId: string | null
  status: BillingSubscriptionStatus | null // null = événement sans statut
  // Tri-état (amendement A1, 2026-07-19 — revue finale I1) : `undefined` =
  // l'événement NE PORTE PAS la notion de période
  // (`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
  // tout type non consommé) → `BillingRepository.applyEvent` PRÉSERVE la
  // valeur déjà en miroir plutôt que de l'écraser. `null` = porté-vide (un
  // `customer.subscription.*` sans aucune période exploitable, ni top-level
  // ni `items.data[0]`) → efface explicitement la colonne. `Date` = la
  // période lue depuis l'événement, écrite telle quelle. Ne JAMAIS confondre
  // `undefined` et `null` ici : c'est exactement la distinction que corrige
  // I1 (l'écrasement systématique à `null` rendait `currentPeriodEnd`
  // intermittent/null en production).
  currentPeriodEnd?: Date | null
}

export class BillingDisabledError extends Error {}
export class BillingSignatureError extends Error {}

export interface BillingPort {
  ensureCustomer(meta: BillingCustomerMeta): Promise<string>
  createCheckoutSession(
    customerId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string>
  createPortalSession(customerId: string, returnUrl: string): Promise<string>
  reportUsage(events: BillingUsageEvent[]): Promise<void>
  constructWebhookEvent(rawBody: Buffer, signature: string): BillingWebhookEvent
}
