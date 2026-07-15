import type { Invoice } from '@factelec/invoice-core'
import Big from 'big.js'
import type {
  AggregatedTransaction,
  TransactionsReport,
} from './flux10-model.js'
import { mapCadreToCategories } from './nomenclature.js'

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
    // DIFFÉRÉ (revue Task 3, BLOQUEUR M*) : un cadre MIXTE (M1/M2/M4) porte
    // les DEUX catégories (TLB1 + TPS1), mais le modèle `Invoice` n'a AUCUN
    // discriminant biens/services au niveau LIGNE (vatBreakdown est groupé
    // par catégorie de TVA ‖ taux) : la ventilation correcte de la base entre
    // TLB1 et TPS1 n'est pas constructible ici, et dupliquer le vatBreakdown
    // sur les deux catégories DOUBLERAIT la base et la TVA déclarées à la
    // DGFiP (M1 1000/200 → 2000/400 : sur-déclaration ×2). L'Annexe 6 impose
    // que l'opérateur distingue LB et PS *par ligne* (total conservé). On
    // DIFFÈRE donc les factures à cadre mixte (comme 10.1/TB-3) jusqu'à une
    // discrimination LB/PS par ligne dans le modèle — dette documentée,
    // suivie Task 10 (go-live).
    const category = categories.length === 1 ? categories[0] : undefined
    if (category === undefined) continue
    for (const vatBreakdown of invoice.vatBreakdown) {
      const key = `${date}|${invoice.currency}|${category}`
      // Invariant (Task 2, finding-1 ; XSD minOccurs=1 sur SubTotals) : le
      // bucket est créé ET inséré dans `buckets` À L'INTÉRIEUR de cette
      // boucle sur `vatBreakdown` (jamais vide, cf. invoiceSchema :
      // `vatBreakdown: z.array(vatBreakdownSchema).min(1)`) -> tout
      // AggregatedTransaction émis a >= 1 subtotal. NE JAMAIS créer de
      // bucket en dehors de cette boucle (un tableau `subtotals` vide
      // produirait du XML XSD-invalide).
      const bucket = buckets.get(key) ?? {
        date,
        currency: invoice.currency,
        categoryCode: category,
        taxExclusiveAmount: '0.00',
        taxTotal: '0.00',
        subtotals: [],
      }
      bucket.taxExclusiveAmount = new Big(bucket.taxExclusiveAmount)
        .plus(vatBreakdown.taxableAmount)
        .toFixed(2)
      bucket.taxTotal = new Big(bucket.taxTotal)
        .plus(vatBreakdown.taxAmount)
        .toFixed(2)
      const subtotal = bucket.subtotals.find(
        (s) => s.taxPercent === vatBreakdown.rate,
      )
      if (subtotal) {
        subtotal.taxableAmount = new Big(subtotal.taxableAmount)
          .plus(vatBreakdown.taxableAmount)
          .toFixed(2)
        subtotal.taxTotal = new Big(subtotal.taxTotal)
          .plus(vatBreakdown.taxAmount)
          .toFixed(2)
      } else {
        bucket.subtotals.push({
          taxPercent: vatBreakdown.rate,
          taxableAmount: vatBreakdown.taxableAmount,
          taxTotal: vatBreakdown.taxAmount,
        })
      }
      buckets.set(key, bucket)
    }
  }

  // Période dont les SEULES factures 10.3 sont à cadre mixte (différées
  // ci-dessus) : aucun agrégat -> transmission à blanc (null, D6). Garantit
  // aussi qu'un TransactionsReport émis a toujours >= 1 agrégat.
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
