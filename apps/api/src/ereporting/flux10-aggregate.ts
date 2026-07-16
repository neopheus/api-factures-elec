import type { Invoice, VatBreakdown } from '@factelec/invoice-core'
import { computeVatBreakdownByNature } from '@factelec/invoice-core'
import { Logger } from '@nestjs/common'
import Big from 'big.js'
import type {
  AggregatedTransaction,
  TransactionsReport,
} from './flux10-model.js'
import type { Flux10Category } from './nomenclature.js'
import { mapCadreToCategories } from './nomenclature.js'

const logger = new Logger('flux10-aggregate')

// Dérive un TransactionsReport (TB-2) des factures d'une période, MAIS
// uniquement pour les opérations réellement e-reportables B2C (10.3, §2.3.3).
// Amendement A1 (revue Task 3) : sans classifieur, l'agrégation e-reporterait
// des opérations B2B DOMESTIQUES qui relèvent de l'e-invoicing (Flux 1-9), pas
// de l'e-reporting -> non-conformité. Le classifieur ci-dessous distingue les
// 3 cas prévus par la spec à partir des seuls champs du modèle `Invoice`
// (buyer/seller.address.countryCode, buyer.siren/vatId — aucun champ dédié
// « assujetti/non-assujetti » n'existe dans le modèle : cf. heuristique
// documentée ci-dessous).
export type EreportingOperationClass = '10.1' | '10.3' | 'out'

// Classifie une facture au regard de l'e-reporting (PURE, aucun effet de bord).
//
// - '10.1' (B2B international) : opération TRANSFRONTALIÈRE (acheteur OU
//   vendeur hors France). CLASSIFIÉ mais DIFFÉRÉ dans ce plan (comme TB-3) :
//   ni agrégé, ni émis ici. cf. TransactionsReport.invoices (TG-8), qui reste
//   toujours vide en sortie de `aggregateTransactions` — le mapping par
//   facture (Flux10Invoice) est une infrastructure future, non câblée.
//   LIMITE CONNUE (revue Task 3, F2 — à re-router au go-live) : un EXPORT B2C
//   (vendeur FR, particulier étranger) tombe ici en '10.1' par la règle pays
//   alors que ce n'est PAS du B2B international. Sans conséquence tant que
//   '10.1' n'est ni agrégé ni émis (différé), mais la re-classification fine
//   (10.1 vs 10.2 vs B2C export) devra être faite quand 10.1 sera livré.
// - '10.3' (B2C domestique) : acheteur en France ET NON-ASSUJETTI. À AGRÉGER
//   (le socle de ce plan).
// - 'out' (B2B domestique) : acheteur en France ET ASSUJETTI -> relève de
//   l'e-invoicing (Flux 1-9), EXCLU de l'e-reporting.
//
// INTERPRÉTATION PROJET (à confirmer au go-live, Annexe 7) : le modèle
// `Invoice` (`@factelec/invoice-core`) n'a pas de champ booléen dédié
// « assujetti ». L'heuristique retenue est la présence d'un identifiant fiscal
// acheteur : SIREN/SIRET (BT-47) OU numéro de TVA intracommunautaire (BT-48).
// Un acheteur qui ne porte NI l'un NI l'autre est traité comme une personne
// physique non-assujettie (10.3). Cette heuristique est documentée à
// confirmer/valider au go-live (suivi Task 10).
export function classifyEreportingOperation(
  invoice: Invoice,
): EreportingOperationClass {
  const crossBorder =
    invoice.buyer.address.countryCode !== 'FR' ||
    invoice.seller.address.countryCode !== 'FR'
  if (crossBorder) return '10.1'

  const buyerIsTaxable =
    Boolean(invoice.buyer.siren) || Boolean(invoice.buyer.vatId)
  return buyerIsTaxable ? 'out' : '10.3'
}

export interface AggregateOptions {
  periodStart: string // AAAAMMJJ
  periodEnd: string // AAAAMMJJ
}

// Accumule une ligne de ventilation TVA (`VatBreakdown` canonique OU issue de
// `computeVatBreakdownByNature`, même forme) dans le bucket (date‖devise‖
// catégorie Flux 10). `category` est TOUJOURS fournie par l'appelant (TLB1/
// TPS1/etc, nomenclature Flux 10) — jamais dérivée de `entry.category` (qui
// porte la catégorie de TVA UNTDID 5305, ex. S/E/Z, un axe DIFFÉRENT). Big.js
// pour les sommes (BT→TT), 2 décimales (montants `amount2`).
//
// Invariant (Task 2, finding-1 ; XSD minOccurs=1 sur SubTotals) : le bucket
// est créé ET inséré dans `buckets` À L'INTÉRIEUR de cette fonction, appelée
// une fois par entrée de ventilation (jamais vide, cf. invoiceSchema :
// `vatBreakdown: z.array(vatBreakdownSchema).min(1)`, et `goods`/`services`
// ne contiennent que des buckets non-vides — cf. compute.ts) -> tout
// AggregatedTransaction émis a >= 1 subtotal. NE JAMAIS créer de bucket en
// dehors de cette fonction (un tableau `subtotals` vide produirait du XML
// XSD-invalide).
function accumulateBucket(
  buckets: Map<string, AggregatedTransaction>,
  date: string,
  currency: string,
  category: Flux10Category,
  entry: Pick<VatBreakdown, 'rate' | 'taxableAmount' | 'taxAmount'>,
): void {
  const key = `${date}|${currency}|${category}`
  const bucket = buckets.get(key) ?? {
    date,
    currency,
    categoryCode: category,
    taxExclusiveAmount: '0.00',
    taxTotal: '0.00',
    subtotals: [],
  }
  bucket.taxExclusiveAmount = new Big(bucket.taxExclusiveAmount)
    .plus(entry.taxableAmount)
    .toFixed(2)
  bucket.taxTotal = new Big(bucket.taxTotal).plus(entry.taxAmount).toFixed(2)
  const subtotal = bucket.subtotals.find((s) => s.taxPercent === entry.rate)
  if (subtotal) {
    subtotal.taxableAmount = new Big(subtotal.taxableAmount)
      .plus(entry.taxableAmount)
      .toFixed(2)
    subtotal.taxTotal = new Big(subtotal.taxTotal)
      .plus(entry.taxAmount)
      .toFixed(2)
  } else {
    bucket.subtotals.push({
      taxPercent: entry.rate,
      taxableAmount: entry.taxableAmount,
      taxTotal: entry.taxAmount,
    })
  }
  buckets.set(key, bucket)
}

// Dérive un TransactionsReport des factures B2C (10.3) d'une période. null si
// aucune opération 10.3 (transmission à blanc OPTIONNELLE, D6). Chaque facture
// est d'abord classée (`classifyEreportingOperation`) ; seules les '10.3' sont
// agrégées. Les '10.1' (B2B international, différé) et 'out' (B2B domestique,
// e-invoicing) sont EXCLUES de cet agrégat — ni comptées, ni émises.
export function aggregateTransactions(
  invoices: Invoice[],
  opts: AggregateOptions,
): TransactionsReport | null {
  const eligible = invoices.filter(
    (invoice) => classifyEreportingOperation(invoice) === '10.3',
  )
  if (eligible.length === 0) return null

  // Groupage (date ‖ devise ‖ catégorie) — Big.js pour les sommes (BT→TT).
  const buckets = new Map<string, AggregatedTransaction>()
  let deferredMixed = 0
  for (const invoice of eligible) {
    // INTERPRÉTATION PROJET (à confirmer au go-live, Annexe 7) : la date de
    // transaction TT-77 = issueDate (BT-2) de la facture.
    const date = invoice.issueDate.replaceAll('-', '')
    const categories = invoice.businessProcessType
      ? mapCadreToCategories(invoice.businessProcessType)
      : // INTERPRÉTATION PROJET (à confirmer au go-live, Annexe 7) : catégorie
        // par défaut si BT-23 (cadre de facturation) absent -> TLB1 (livraison
        // de biens).
        (['TLB1'] as const)

    if (categories.length > 1) {
      // Cadre MIXTE (M1/M2/M4, TLB1+TPS1) — Task 2, résolution du différé
      // 2.3-T3 : avec le discriminant `nature` de ligne (Task 1), on
      // construit la VRAIE ventilation TLB1(biens)/TPS1(services), total
      // conservé, JAMAIS doublée (`computeVatBreakdownByNature`, total
      // conservé par construction — cf. compute.ts). Une facture dont AU
      // MOINS une ligne n'a pas de `nature` reste différée à l'identique de
      // 2.3 (skip typé + log ; aucune ventilation partielle fabriquée).
      const byNature = computeVatBreakdownByNature(invoice)
      if (!byNature.complete) {
        deferredMixed++
        continue
      }
      // Injection T1(b) ratifiée : `goods`/`services` sont des `VatBreakdown[]`
      // (même forme que la ventilation canonique), mais l'ASYMÉTRIE documentée
      // dans `computeVatBreakdownByNature` (le bucket `services`, dérivé par
      // soustraction, ne porte JAMAIS `exemptionReasonCode`/`exemptionReason`,
      // contrairement à `goods`, recalculé) est SANS CONSÉQUENCE ici :
      // `accumulateBucket` ne consomme QUE `rate`/`taxableAmount`/`taxAmount`,
      // et la `category` Flux 10 (TLB1/TPS1) est TOUJOURS celle passée en
      // paramètre par ce bloc, jamais `entry.category` (S/E/Z…, un axe TVA
      // distinct de la nomenclature Flux 10 TT-81).
      for (const entry of byNature.goods) {
        accumulateBucket(buckets, date, invoice.currency, 'TLB1', entry)
      }
      for (const entry of byNature.services) {
        accumulateBucket(buckets, date, invoice.currency, 'TPS1', entry)
      }
      continue
    }

    // `categories.length === 1` ici (mixte traité + `continue` ci-dessus ;
    // `mapCadreToCategories`/le repli par défaut ne renvoient jamais un
    // tableau vide) — assertion non-null au lieu d'une garde `undefined`
    // qui introduirait une branche morte, non atteignable (100 % branches).
    // biome-ignore lint/style/noNonNullAssertion: catégorie unique garantie non-vide par construction (cf. commentaire ci-dessus) ; une garde ici serait une branche morte non testable.
    const category = categories[0]!
    for (const vatBreakdown of invoice.vatBreakdown) {
      accumulateBucket(buckets, date, invoice.currency, category, vatBreakdown)
    }
  }

  if (deferredMixed > 0) {
    logger.warn(
      `${deferredMixed} facture(s) à cadre mixte différée(s) (ligne sans nature, cf. computeVatBreakdownByNature)`,
    )
  }

  // Période dont les SEULES factures 10.3 sont à cadre mixte différé
  // (ligne(s) sans nature) : aucun agrégat -> transmission à blanc (null,
  // D6). Garantit aussi qu'un TransactionsReport émis a toujours >= 1 agrégat.
  if (buckets.size === 0) return null

  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    // TG-8 (10.1, B2B international) : classification effectuée mais mapping
    // par facture / émission DIFFÉRÉS dans ce plan (cf. classifyEreportingOperation).
    invoices: [],
    aggregated: [...buckets.values()],
  }
}
