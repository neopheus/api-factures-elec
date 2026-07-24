import type {
  OrderInvoiceLine,
  OrderMappingPayload,
  Party,
} from '@factelec/connectors-sdk'
import type { SellerConfig } from './config.js'

// `import type` uniquement (motif factelec-client.ts) : zéro poids runtime,
// seul le contrat de types du sdk est consommé ici.

/**
 * Commande Shopify → `OrderMappingPayload` (contrat sdk) — PORTE les acquis
 * `connectors/woocommerce/factelec/src/Mapping/OrderMapper.php` (revue
 * phase 4 it.2, motif IDENTIQUE côté PrestaShop) :
 *   - `formatDecimal4()` : précision fiscale préservée jusqu'à 4 décimales
 *     (arrondi PUIS zéros de fin retirés SANS jamais descendre sous 2).
 *   - `vatCategory` "S" si le taux réel > 0, sinon "Z" (CORRECTIF TRANSVERSE
 *     phase 4 it.2, BR-Z-10) — JAMAIS "E" (invoice-core `rules.ts`,
 *     `exemptionReasonRuleByCategory` exige un motif BT-120/BT-121 pour
 *     "E", jamais fourni ici → 422 systématique, pending_retry inépuisable).
 *   - `typeCode` toujours "380" (v1, jamais d'avoir), `unitCode` fixé
 *     "C62", `dueDate`/`businessProcessType`/`buyer.vatId` NON mappés
 *     (aucune convention Shopify établie pour un TVA intracommunautaire
 *     acheteur — même discipline que WooCommerce : non deviné plutôt que
 *     faux).
 *
 * Différences avec le motif WooCommerce, dues au modèle Shopify (design §3) :
 *   - `line_items[].price` est DÉJÀ un prix UNITAIRE (contrairement à
 *     `WC_Order_Item::get_total()`, un total de ligne) — pas de division
 *     par la quantité.
 *   - `tax_lines[].rate` est une FRACTION (0.2 = 20 %), pas un pourcentage
 *     — converti ici (`rate * 100`).
 *   - **UN SEUL taux par ligne** (design §3, décision explicite) : si
 *     `tax_lines.length > 1` (juridictions fiscales composées — rare en
 *     France, courant aux US), sommer les taux serait FAUX (une TVA
 *     composite n'est pas la somme algébrique de ses parts au sens BT-152)
 *     — la commande entière est REJETÉE (`OrderMappingError`, message
 *     clair) plutôt que mappée avec un taux inventé. Un taux `null`
 *     (Shopify : remise fiscale basée sur un montant fixe, pas un
 *     pourcentage) est traité de la MÊME façon — aucune reconstruction
 *     approximative depuis `price`/sous-total.
 *   - SIREN acheteur : `note_attributes` (clé conventionnelle
 *     `factelec_siret`) — PAS un metafield Shopify. Décision documentée
 *     (design §3 « note_attributes plus accessible sans appel API ») : un
 *     metafield exigerait un appel Admin API SUPPLÉMENTAIRE par webhook
 *     traité (latence, nouveau point de défaillance synchrone), alors que
 *     `note_attributes` est DÉJÀ présent dans le payload webhook reçu.
 *     Extension possible en v2 si un besoin réel émerge (non traité ici).
 */

const UNIT_CODE = 'C62'
const TYPE_CODE_INVOICE = '380'
const SIRET_NOTE_ATTRIBUTE = 'factelec_siret'

export interface ShopifyTaxLine {
  title?: string
  price?: string
  /** Fraction (0.2 = 20 %) — `null` quand Shopify ne peut exprimer la taxe
   * comme un pourcentage (remise/taxe à montant fixe). */
  rate: number | null
}

export interface ShopifyLineItem {
  id: number | string
  title: string
  quantity: number
  /** Prix UNITAIRE (pas un total de ligne, contrairement à WooCommerce). */
  price: string
  tax_lines: ShopifyTaxLine[]
}

export interface ShopifyShippingLine {
  id: number | string
  title: string
  price: string
  tax_lines: ShopifyTaxLine[]
}

export interface ShopifyAddress {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  zip?: string | null
  country_code?: string | null
}

export interface ShopifyNoteAttribute {
  name: string
  value: string
}

/** Sous-ensemble consommé du payload webhook `orders/paid`|`orders/fulfilled`. */
export interface ShopifyOrder {
  id: number | string
  name?: string | null
  order_number?: number | string | null
  created_at: string
  currency: string
  billing_address?: ShopifyAddress | null
  note_attributes?: ShopifyNoteAttribute[] | null
  line_items: ShopifyLineItem[]
  shipping_lines?: ShopifyShippingLine[] | null
}

/** Commande structurellement inexploitable — capturée par le handler
 * webhook (Task 2, catch large motif OrderEmissionService.php) et
 * traduite en `pending_retry` ; message JAMAIS porteur de secret. */
export class OrderMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrderMappingError'
  }
}

export function mapOrder(
  order: ShopifyOrder,
  seller: SellerConfig,
): OrderMappingPayload {
  return {
    number: orderNumber(order),
    issueDate: toIssueDate(order),
    typeCode: TYPE_CODE_INVOICE,
    currency: order.currency,
    seller: mapSeller(seller),
    buyer: mapBuyer(order),
    lines: mapLines(order),
  }
}

function orderNumber(order: ShopifyOrder): string {
  return String(order.name ?? order.order_number ?? order.id)
}

/** `created_at` inclut le décalage horaire de la boutique (motif WooCommerce
 * `get_date_created()->format('Y-m-d')`) — on prend le préfixe AAAA-MM-JJ
 * TEL QUEL plutôt que de reconvertir via `Date` (qui décalerait la date
 * calendaire réelle autour de minuit selon le fuseau d'exécution local). */
function toIssueDate(order: ShopifyOrder): string {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(order.created_at ?? '')
  if (!match)
    throw new OrderMappingError(
      'Commande Shopify sans date de création exploitable (created_at absent ou malformé).',
    )
  // biome-ignore lint/style/noNonNullAssertion: le groupe 1 est TOUJOURS capturé si `match` est non-null (regex non-optionnelle).
  return match[1]!
}

function mapSeller(seller: SellerConfig): Party {
  return buildParty(
    seller.name,
    seller.siren,
    seller.vatId,
    seller.address.streetName,
    seller.address.city,
    seller.address.postalCode,
    seller.address.countryCode,
  )
}

/** `billing_address.company` (B2B) si renseigné, sinon prénom+nom (B2C) —
 * même règle que WooCommerce (design §3). SIREN via `note_attributes`
 * (14 chiffres → 9, cf. docblock de fichier) ; `vatId` acheteur NON mappé
 * (limitation v1 assumée). */
function mapBuyer(order: ShopifyOrder): Party {
  const address = order.billing_address
  if (!address)
    throw new OrderMappingError(
      'Commande Shopify sans adresse de facturation exploitable (billing_address absent).',
    )

  const company = (address.company ?? '').trim()
  const name =
    company !== ''
      ? company
      : `${address.first_name ?? ''} ${address.last_name ?? ''}`.trim()
  if (name === '')
    throw new OrderMappingError(
      'Commande Shopify sans nom acheteur exploitable (ni société, ni prénom/nom).',
    )

  const streetName =
    `${address.address1 ?? ''} ${address.address2 ?? ''}`.trim()

  return buildParty(
    name,
    sirenFromNoteAttributes(order.note_attributes),
    undefined,
    streetName,
    address.city ?? undefined,
    address.zip ?? undefined,
    address.country_code ?? '',
  )
}

/** Champs optionnels du schéma (`streetName`/`city`/`postalCode`/`siren`/
 * `vatId`) ont tous `minLength: 1` — les OMETTRE quand vides est OBLIGATOIRE
 * (motif buildParty WooCommerce), pas cosmétique. */
function buildParty(
  name: string,
  siren: string | undefined,
  vatId: string | undefined,
  streetName: string | undefined,
  city: string | undefined,
  postalCode: string | undefined,
  countryCode: string,
): Party {
  const address: Party['address'] = { countryCode }
  if (streetName?.trim()) address.streetName = streetName.trim()
  if (city?.trim()) address.city = city.trim()
  if (postalCode?.trim()) address.postalCode = postalCode.trim()

  const party: Party = { name, address }
  if (siren?.trim()) party.siren = siren.trim()
  if (vatId?.trim()) party.vatId = vatId.trim()
  return party
}

/** SIRET 14 chiffres (`note_attributes[].name === 'factelec_siret'`) → 9
 * premiers chiffres (SIREN, seule l'entreprise compte pour la facturation
 * électronique — motif WooCommerce `sirenFromSiret`). Absent, mal formé ou
 * non numérique → `undefined` (particulier B2C), jamais une erreur. */
function sirenFromNoteAttributes(
  attributes: ShopifyNoteAttribute[] | null | undefined,
): string | undefined {
  const siret = attributes
    ?.find((a) => a.name === SIRET_NOTE_ATTRIBUTE)
    ?.value?.trim()
  if (!siret || !/^\d{14}$/.test(siret)) return undefined
  return siret.slice(0, 9)
}

/** `line_items` (prix UNITAIRE déjà fourni par Shopify) + `shipping_lines`
 * (ligne dédiée UNIQUEMENT si le montant est non nul, design §3). */
function mapLines(order: ShopifyOrder): OrderInvoiceLine[] {
  const lines = order.line_items.map((item) => {
    const rate = resolveLineRate(
      item.tax_lines,
      `article "${item.title}" (id=${item.id})`,
    )
    return {
      id: String(item.id),
      name: item.title,
      quantity: String(item.quantity),
      unitCode: UNIT_CODE,
      unitPrice: formatDecimal4(parseAmount(item.price)),
      vatCategory: rate > 0 ? ('S' as const) : ('Z' as const),
      vatRate: formatDecimal4(rate),
    }
  })

  for (const shipping of order.shipping_lines ?? []) {
    const amount = parseAmount(shipping.price)
    if (amount <= 0) continue // frais de port nuls : aucune ligne dédiée (design §3).
    const rate = resolveLineRate(
      shipping.tax_lines,
      `frais de port "${shipping.title}" (id=${shipping.id})`,
    )
    lines.push({
      id: String(shipping.id),
      name: shipping.title,
      quantity: '1',
      unitCode: UNIT_CODE,
      unitPrice: formatDecimal4(amount),
      vatCategory: rate > 0 ? 'S' : 'Z',
      vatRate: formatDecimal4(rate),
    })
  }

  return lines
}

/**
 * UN SEUL taux par ligne (design §3, décision explicite — cf. docblock de
 * fichier). Aucune `tax_lines` → 0 % (article non taxé, catégorie "Z").
 * Plusieurs `tax_lines`, OU un taux `null` (remise fiscale à montant fixe,
 * non exprimable en pourcentage) → `OrderMappingError` : jamais de somme
 * inventée, jamais de reconstruction approximative.
 */
function resolveLineRate(taxLines: ShopifyTaxLine[], context: string): number {
  if (taxLines.length === 0) return 0
  if (taxLines.length > 1)
    throw new OrderMappingError(
      `Taux de TVA composite non supporté pour ${context} (${taxLines.length} tax_lines — sommer les taux serait incorrect, cf. design §3).`,
    )
  // biome-ignore lint/style/noNonNullAssertion: longueur exactement 1 garantie par les deux gardes ci-dessus.
  const line = taxLines[0]!
  if (line.rate === null || line.rate === undefined)
    throw new OrderMappingError(
      `Taux de TVA non exprimable en pourcentage pour ${context} (tax_lines[0].rate absent).`,
    )
  return line.rate * 100
}

function parseAmount(value: string): number {
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount))
    throw new OrderMappingError(
      `Montant Shopify non numérique exploitable : "${value}".`,
    )
  return amount
}

/**
 * Formate un montant/taux au format decimal4 du schéma
 * (`^\d+(\.\d{1,4})?$`) — PORTÉ À L'IDENTIQUE de
 * `connectors/woocommerce/factelec/src/Mapping/OrderMapper.php::formatDecimal4`
 * (revue Task 4 PrestaShop, Minor) : arrondi à 4 décimales (limite du
 * schéma) PUIS les zéros de fin non significatifs sont retirés SANS jamais
 * descendre sous 2 décimales (convention monétaire, compatibilité
 * ascendante avec les fixtures sdk). `Math.round` sur une valeur
 * pré-multipliée (pas `toFixed` seul en amont) : évite les artefacts
 * d'arithmétique flottante (ex. un taux `0.145 * 100` naïf peut produire
 * `14.499999999999998`).
 */
export function formatDecimal4(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 10_000) / 10_000
  const withoutTrailingZeros = rounded
    .toFixed(4)
    .replace(/0+$/, '')
    .replace(/\.$/, '')
  const [integerPart, decimalPart = ''] = withoutTrailingZeros.split('.')
  return `${integerPart}.${decimalPart.padEnd(2, '0')}`
}
