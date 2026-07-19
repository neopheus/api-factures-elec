import { pathToFileURL } from 'node:url'
import Stripe from 'stripe'

// Couplé à STRIPE_BILLING_DRIVER (apps/api/src/billing/stripe-billing.driver.ts,
// const METER_EVENT_NAME) : même valeur volontairement dupliquée plutôt
// qu'importée — ce script vit hors de la frontière `src/` (montants
// business exclus de `src/`, seul ce bootstrap sandbox les connaît). Si le
// nom d'event change côté driver, il DOIT changer ici aussi.
const METER_EVENT_NAME = 'documents_processed'

const LOOKUP_KEY_BASE = 'factelec_base'
const LOOKUP_KEY_METERED = 'factelec_metered'

export interface BillingCatalog {
  priceBase: string
  priceMetered: string
}

// Cherche un meter actif portant l'event_name attendu ; en crée un sinon.
// Appelé UNIQUEMENT si le price métré doit être (re)créé — inutile
// d'interroger/créer un meter que personne ne référencera.
async function findOrCreateMeter(stripe: Stripe): Promise<string> {
  const meters = await stripe.billing.meters.list()
  const active = meters.data.find(
    (meter) =>
      meter.event_name === METER_EVENT_NAME && meter.status === 'active',
  )
  if (active) return active.id
  const created = await stripe.billing.meters.create({
    display_name: 'Documents traités',
    event_name: METER_EVENT_NAME,
    default_aggregation: { formula: 'sum' },
    customer_mapping: {
      event_payload_key: 'stripe_customer_id',
      type: 'by_id',
    },
    value_settings: { event_payload_key: 'value' },
  })
  return created.id
}

// Cherche le product Factelec (identifié par metadata, pas par nom — un
// nom affiché peut changer sans casser l'idempotence) ; en crée un sinon.
async function findOrCreateProduct(stripe: Stripe): Promise<string> {
  const found = await stripe.products.search({
    query: "metadata['factelec']:'base'",
  })
  const existing = found.data[0]
  if (existing) return existing.id
  const created = await stripe.products.create({
    name: 'Factelec',
    metadata: { factelec: 'base' },
  })
  return created.id
}

// Idempotente par lookup_key : ne crée que ce qui manque réellement, et ne
// touche jamais à un objet existant (aucun update). Les MONTANTS (2900
// centimes, tiers 0/100/20) sont volontairement câblés en dur ICI — c'est
// le seul endroit du dépôt autorisé à les connaître, en dehors de `src/`.
export async function ensureBillingCatalog(
  stripe: Stripe,
): Promise<BillingCatalog> {
  const existingPrices = await stripe.prices.list({
    lookup_keys: [LOOKUP_KEY_BASE, LOOKUP_KEY_METERED],
    limit: 10,
  })
  let priceBaseId = existingPrices.data.find(
    (price) => price.lookup_key === LOOKUP_KEY_BASE,
  )?.id
  let priceMeteredId = existingPrices.data.find(
    (price) => price.lookup_key === LOOKUP_KEY_METERED,
  )?.id

  if (priceBaseId && priceMeteredId) {
    // Catalogue déjà complet : aucune écriture, même pas une lecture du
    // product/meter — on ne fait que ce qui est nécessaire.
    return { priceBase: priceBaseId, priceMetered: priceMeteredId }
  }

  // Au moins un des deux prices manque : les deux sont rattachés au même
  // product, donc on le résout (ou le crée) une seule fois ici.
  const productId = await findOrCreateProduct(stripe)

  if (!priceBaseId) {
    const created = await stripe.prices.create({
      product: productId,
      currency: 'eur',
      unit_amount: 2900,
      recurring: { interval: 'month' },
      lookup_key: LOOKUP_KEY_BASE,
      tax_behavior: 'exclusive',
    })
    priceBaseId = created.id
  }

  if (!priceMeteredId) {
    const meterId = await findOrCreateMeter(stripe)
    const created = await stripe.prices.create({
      product: productId,
      currency: 'eur',
      recurring: {
        interval: 'month',
        usage_type: 'metered',
        meter: meterId,
      },
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      // Les 100 premiers documents du mois sont gratuits (palier 0), au-delà
      // 20 centimes/document — graduated : chaque palier ne s'applique qu'à
      // sa propre tranche, pas à l'usage total.
      tiers: [
        { up_to: 100, unit_amount: 0 },
        { up_to: 'inf', unit_amount: 20 },
      ],
      lookup_key: LOOKUP_KEY_METERED,
      tax_behavior: 'exclusive',
    })
    priceMeteredId = created.id
  }

  return { priceBase: priceBaseId, priceMetered: priceMeteredId }
}

async function main(): Promise<void> {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) {
    throw new Error(
      'STRIPE_SECRET_KEY manquant : impossible de lancer le bootstrap catalogue Stripe.',
    )
  }
  if (!secretKey.startsWith('sk_test_')) {
    // Avertissement, pas un blocage : l'exploitant peut vouloir provisionner
    // le catalogue live en connaissance de cause (ex. environnement live
    // fraîchement créé, avant tout produit réel).
    console.warn(
      "AVERTISSEMENT : STRIPE_SECRET_KEY ne commence pas par 'sk_test_' — " +
        'ce bootstrap est pensé pour la sandbox Stripe. Poursuite du ' +
        'provisioning malgré tout.',
    )
  }
  const stripe = new Stripe(secretKey)
  const catalog = await ensureBillingCatalog(stripe)
  // Format copiable tel quel dans .env : ne rien ajouter d'autre sur ces
  // deux lignes (pas de JSON, pas de préfixe de log).
  console.log(`STRIPE_PRICE_BASE=${catalog.priceBase}`)
  console.log(`STRIPE_PRICE_METERED=${catalog.priceMetered}`)
}

// Le script ne s'exécute QUE lancé directement (`node --import tsx
// scripts/billing-bootstrap.ts`) — jamais à l'import par les tests unit, qui
// n'exercent que `ensureBillingCatalog` avec un Stripe mocké.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
