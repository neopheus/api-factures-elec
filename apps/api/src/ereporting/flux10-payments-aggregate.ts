import type { Invoice } from '@factelec/invoice-core'
import { computeVatBreakdownByNature } from '@factelec/invoice-core'
import { Logger } from '@nestjs/common'
import Big from 'big.js'
import type {
  PaymentRow,
  PaymentSubtotalRow,
} from '../payments/payments.repository.js'
import { classifyEreportingOperation } from './flux10-aggregate.js'
import type {
  Flux10PaymentAggregate,
  Flux10PaymentInvoice,
  PaymentsReport,
} from './flux10-model.js'

const logger = new Logger('flux10-payments-aggregate')

// BANNIÈRE SERVICES-ONLY (§3.7.4 note 119, dossier général v3.2, revue
// plan-3-2-review.md §Task 3.2/Task 7 finding A-T7-1, BINDING, citée
// VERBATIM) :
//
//   « Les données de paiement ne doivent être transmises qu'en cas de
//     prestations de services, hors opérations donnant lieu à
//     autoliquidation de la TVA et option de TVA sur les débits. »
//
// L'e-reporting PAIEMENT (TVA à l'encaissement) ne concerne donc QUE les
// prestations de services — les livraisons de biens en sont EXCLUES, quel
// que soit le sous-flux (10.2 per-facture OU 10.4 agrégé).
//
// INTERPRÉTATION PROJET (règle de proratisation, FLAGGÉE go-live) : un
// encaissement référence UNE facture, qui peut mêler biens et services sur
// des lignes DISTINCTES (le discriminant `nature`, Task 1, est au niveau
// ligne, pas facture) ; le modèle de capture (D5, Task 4/5) ne porte
// lui-même qu'un `taxPercent`+`amount` par sous-total, JAMAIS un identifiant
// de ligne — impossible de savoir directement QUELLES lignes un encaissement
// solde. Règle retenue (la plus défendable, testée) : la part SERVICES d'un
// encaissement, PAR TAUX, est estimée au PRORATA de la part que les services
// représentent, pour ce taux, dans le TOTAL TTC canonique de la facture liée
// (`computeVatBreakdownByNature`, sommé sur toutes les catégories partageant
// ce taux — motif de la revue T5 LOW-1, plafond de sur-encaissement) :
//
//   ratio(taux) = servicesTTC(taux) / canonicalTTC(taux)
//   montantServices(taux) = montantEncaissé(taux) × ratio(taux), 2 décimales
//
// Une facture TOUT-SERVICES (ratio=1 partout) n'est jamais tronquée ; une
// facture TOUT-BIENS (ratio=0 partout) est intégralement EXCLUE (aucun
// encaissement résiduel émis) — comme une facture SANS AUCUNE opération
// e-reportable dans `aggregateTransactions` (D6). Le NUMÉRATEUR exclut en
// outre la catégorie TVA `AE` (autoliquidation, UNTDID 5305) de la part
// « services » — application directe de la clause « hors autoliquidation »
// de la note 119, sans champ dédié à fabriquer (le discriminant de
// catégorie TVA existe déjà, `VatBreakdown.category`). La seconde clause de
// la note 119 (« hors option de TVA sur les débits ») N'A AUCUN champ
// correspondant dans le modèle `Invoice` — DIFFÉRÉE HONNÊTEMENT (aucune
// fabrication d'un signal qui n'existe pas), limitation documentée pour le
// go-live (Annexe 7).
//
// Cas INDÉCIDABLE (D3, aucune fabrication) : une facture liée dont AU MOINS
// une ligne n'a pas de `nature` (`computeVatBreakdownByNature` ->
// `complete:false`) est DIFFÉRÉE (skip typé + log, `deferredIncomplete`) —
// jamais de ventilation partielle fabriquée sur hypothèse, même posture que
// le différé des cadres M* (Task 2/D3).
const AUTOLIQUIDATION_CATEGORY = 'AE'

function normalizeRate(rate: string): string {
  return new Big(rate).toString()
}

// Ratio SERVICES (hors autoliquidation) par taux, sommé sur toutes les
// catégories TVA partageant ce taux (un même taux peut être porté par
// plusieurs catégories, ex. Z et E à 0 % — motif T5 LOW-1).
function serviceRatioByRate(invoice: Invoice): Map<string, Big> {
  const canonicalByRate = new Map<string, Big>()
  for (const entry of invoice.vatBreakdown) {
    const key = normalizeRate(entry.rate)
    const current = canonicalByRate.get(key) ?? new Big(0)
    canonicalByRate.set(
      key,
      current.plus(entry.taxableAmount).plus(entry.taxAmount),
    )
  }

  const byNature = computeVatBreakdownByNature(invoice)
  const servicesByRate = new Map<string, Big>()
  for (const entry of byNature.services) {
    if (entry.category === AUTOLIQUIDATION_CATEGORY) continue // note 119 : hors autoliquidation
    const key = normalizeRate(entry.rate)
    const current = servicesByRate.get(key) ?? new Big(0)
    servicesByRate.set(
      key,
      current.plus(entry.taxableAmount).plus(entry.taxAmount),
    )
  }

  const ratios = new Map<string, Big>()
  for (const [rate, canonicalTtc] of canonicalByRate) {
    const servicesTtc = servicesByRate.get(rate) ?? new Big(0)
    ratios.set(
      rate,
      canonicalTtc.eq(0) ? new Big(0) : servicesTtc.div(canonicalTtc),
    )
  }
  return ratios
}

// Applique le ratio services par taux aux sous-totaux CAPTURÉS d'un
// encaissement ; omet tout sous-total dont la part services est nulle (taux
// intégralement biens/autoliquidation à cette facture) — jamais de
// sous-total à 0.00 fabriqué.
function prorateServiceSubtotals(
  invoice: Invoice,
  subtotals: PaymentSubtotalRow[],
): PaymentSubtotalRow[] {
  const ratios = serviceRatioByRate(invoice)
  const result: PaymentSubtotalRow[] = []
  for (const subtotal of subtotals) {
    const ratio = ratios.get(normalizeRate(subtotal.taxPercent)) ?? new Big(0)
    if (ratio.eq(0)) continue
    const amount = new Big(subtotal.amount).times(ratio).toFixed(2)
    if (new Big(amount).eq(0)) continue
    result.push({ taxPercent: subtotal.taxPercent, amount })
  }
  return result
}

export interface PaymentAggregateOptions {
  periodStart: string // AAAAMMJJ
  periodEnd: string // AAAAMMJJ
  // Fetch du canonique PAR PAIEMENT (motif injecté, testable) : la facture
  // liée porte buyer/seller (classification), vatBreakdown et nature de
  // ligne (services-only) — aucune de ces données n'est dupliquée dans
  // `payments`/`payment_subtotals` (D5). `null` = facture introuvable
  // (disparition théoriquement empêchée par la FK restrict, Task 4) —
  // traité défensivement comme un encaissement différé (log + skip), jamais
  // un throw (motif `EreportingGenerationService` « déclarant disparu »).
  loadInvoice: (invoiceId: string) => Promise<Invoice | null>
}

// Dérive un PaymentsReport (TB-3) des encaissements d'une période. Pour
// chaque encaissement : classe la facture liée (`classifyEreportingOperation`,
// réutilisé de flux10-aggregate.ts) -> '10.1' (B2Bi) émet une
// `Flux10PaymentInvoice` PAR ENCAISSEMENT dans `invoices[]` (10.2 — la forme
// XSD porte UN SEUL `Payment` par `Invoice`, donc plusieurs encaissements
// partiels de la MÊME facture produisent naturellement plusieurs éléments
// `<Invoice>`, jamais fusionnés) ; '10.3' (B2C) AGRÈGE dans `transactions[]`
// par (paymentDate, taxPercent) — SANS réf facture ni catégorie (10.4, D7) ;
// 'out' EXCLU. Chaque encaissement traverse d'abord le filtre SERVICES-ONLY
// (note 119, bannière ci-dessus) : un encaissement dont la part services est
// nulle à TOUS les taux (facture 100% biens, ou nature incomplète -> différé)
// ne produit RIEN. `null` si AUCUNE opération e-reportable (transmission à
// blanc optionnelle, même posture que `aggregateTransactions`, D6).
export async function aggregatePayments(
  rows: PaymentRow[],
  opts: PaymentAggregateOptions,
): Promise<PaymentsReport | null> {
  const invoiceForms: Flux10PaymentInvoice[] = []
  const aggregateBuckets = new Map<string, Flux10PaymentAggregate>()
  let deferredIncomplete = 0

  for (const row of rows) {
    const invoice = await opts.loadInvoice(row.invoiceId)
    if (!invoice) {
      logger.warn(
        `aggregatePayments: facture ${row.invoiceId} introuvable pour l'encaissement ${row.id} — ignoré`,
      )
      continue
    }

    const operationClass = classifyEreportingOperation(invoice)
    if (operationClass === 'out') continue

    const byNature = computeVatBreakdownByNature(invoice)
    if (!byNature.complete) {
      deferredIncomplete++
      continue
    }

    const serviceSubtotals = prorateServiceSubtotals(invoice, row.subtotals)
    if (serviceSubtotals.length === 0) continue

    if (operationClass === '10.1') {
      invoiceForms.push({
        invoiceId: invoice.number, // TT-91 : numéro de facture (BT-1), pas l'id DB
        issueDate: invoice.issueDate.replaceAll('-', ''), // TT-102, AAAAMMJJ
        paymentDate: row.paymentDate,
        subtotals: serviceSubtotals.map((st) => ({
          taxPercent: st.taxPercent,
          amount: st.amount,
          currency: row.currency,
        })),
      })
      continue
    }

    // '10.3' -> agrégé par (paymentDate, taxPercent), SANS réf facture ni
    // catégorie (D7). Groupage par date au niveau du bucket (un
    // `Flux10PaymentAggregate` = un `<Transactions>`, un seul `Payment/Date`
    // structurellement, motif TG-37/38) ; les sous-totaux à l'intérieur sont
    // fusionnés (big.js) par taux, y compris entre factures DIFFÉRENTES
    // (aucune réf facture dans la forme agrégée).
    const bucket = aggregateBuckets.get(row.paymentDate) ?? {
      paymentDate: row.paymentDate,
      subtotals: [],
    }
    for (const st of serviceSubtotals) {
      const existing = bucket.subtotals.find(
        (s) => s.taxPercent === st.taxPercent,
      )
      if (existing) {
        existing.amount = new Big(existing.amount).plus(st.amount).toFixed(2)
      } else {
        bucket.subtotals.push({
          taxPercent: st.taxPercent,
          amount: st.amount,
          currency: row.currency,
        })
      }
    }
    aggregateBuckets.set(row.paymentDate, bucket)
  }

  if (deferredIncomplete > 0) {
    logger.warn(
      `${deferredIncomplete} encaissement(s) différé(s) (facture liée à nature de ligne incomplète, cf. computeVatBreakdownByNature)`,
    )
  }

  if (invoiceForms.length === 0 && aggregateBuckets.size === 0) return null

  return {
    periodStart: opts.periodStart,
    periodEnd: opts.periodEnd,
    invoices: invoiceForms,
    transactions: [...aggregateBuckets.values()],
  }
}
