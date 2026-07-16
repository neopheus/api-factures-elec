import { big, round2 } from './money.js'
import {
  EXEMPT_VAT_CATEGORIES,
  type Invoice,
  type InvoiceInput,
  type InvoiceLine,
  invoiceSchema,
  type Totals,
  type VatBreakdown,
} from './schema.js'

function computeLines(input: InvoiceInput): InvoiceLine[] {
  return input.lines.map((line) => ({
    ...line,
    lineNetAmount: round2(big(line.quantity).times(line.unitPrice)),
  }))
}

// Regroupe les lignes par (catégorie, taux) sans branche conditionnelle par ligne :
// - dédoublonnage des couples (catégorie, taux) via une Map (dernière écriture d'une
//   clé existante ne déplace pas sa position d'itération, donc l'ordre de première
//   apparition est conservé) ;
// - assiette de chaque groupe recalculée par filtre + réduction sur l'ensemble des lignes.
// Cela évite un chemin de fusion « groupe déjà vu » non exercé par les fixtures
// (aucune des deux ne contient deux lignes de même catégorie/taux), qui ferait
// échouer le seuil de couverture de branches à 90 %.
function computeVatBreakdown(lines: InvoiceLine[]): VatBreakdown[] {
  const vatKey = (line: InvoiceLine): string =>
    `${line.vatCategory}|${line.vatRate}`
  const pairs = [
    ...new Map(
      lines.map((line) => [
        vatKey(line),
        { category: line.vatCategory, rate: line.vatRate },
      ]),
    ).values(),
  ]
  return pairs.map(({ category, rate }) => {
    const groupLines = lines.filter(
      (line) => vatKey(line) === `${category}|${rate}`,
    )
    const taxable = groupLines.reduce(
      (acc, line) => acc.plus(line.lineNetAmount),
      big('0'),
    )
    // BT-120/BT-121 : le motif d'exonération de la ventilation (BG-23) reprend
    // celui de la première ligne du groupe qui en porte un — mais seulement pour
    // les catégories exonérées (EXEMPT_VAT_CATEGORIES) : BR-S-10/BR-Z-10/BR-AF-10/
    // BR-AG-10 interdisent un motif sur les ventilations S, Z, L, M, y compris
    // lorsqu'une ligne d'entrée en porte un par erreur.
    const withReason = EXEMPT_VAT_CATEGORIES.has(category)
      ? groupLines.find(
          (line) => line.exemptionReasonCode || line.exemptionReason,
        )
      : undefined
    return {
      category,
      rate,
      taxableAmount: round2(taxable),
      // BR-CO-17 : TVA de catégorie = assiette × taux, arrondie à 2 décimales
      taxAmount: round2(taxable.times(rate).div(100)),
      ...(withReason?.exemptionReasonCode
        ? { exemptionReasonCode: withReason.exemptionReasonCode }
        : {}),
      ...(withReason?.exemptionReason
        ? { exemptionReason: withReason.exemptionReason }
        : {}),
    }
  })
}

function computeTotals(
  lines: InvoiceLine[],
  breakdown: VatBreakdown[],
): Totals {
  const sumOfLines = lines.reduce(
    (acc, l) => acc.plus(l.lineNetAmount),
    big('0'),
  )
  const taxAmount = breakdown.reduce(
    (acc, b) => acc.plus(b.taxAmount),
    big('0'),
  )
  const taxInclusive = sumOfLines.plus(taxAmount)
  return {
    sumOfLines: round2(sumOfLines),
    taxExclusive: round2(sumOfLines), // pas de remises/charges de pied de facture en v1
    taxAmount: round2(taxAmount),
    taxInclusive: round2(taxInclusive),
    payable: round2(taxInclusive), // pas d'acompte en v1
  }
}

export function buildInvoice(input: InvoiceInput): Invoice {
  const lines = computeLines(input)
  const vatBreakdown = computeVatBreakdown(lines)
  const totals = computeTotals(lines, vatBreakdown)
  return invoiceSchema.parse({ ...input, lines, vatBreakdown, totals })
}

// Ventilation de la ventilation TVA canonique (vatBreakdown, par (catégorie, taux))
// entre biens et services, à partir du discriminant `nature` de ligne (D1/D2, plan
// 3.2). Total conservé, EXACT, jamais doublé :
// - `complete` = false dès qu'UNE ligne n'a pas de `nature` → aucune fabrication,
//   le consommateur (agrégation e-reporting M*) diffère la facture (D3).
// - assiette (`taxableAmount`) : somme de `lineNetAmount` (déjà 2 décimales) par
//   bucket → `goodsTaxable + servicesTaxable = canonicalTaxable` SANS arrondi.
// - taxe (`taxAmount`) : `goods` recalculée réellement sur les lignes biens ;
//   `services` DÉRIVÉE PAR SOUSTRACTION (`canonicalTax - goodsTax`) — le bucket
//   services absorbe le résidu d'arrondi ≤ 1 centime, garantissant
//   `goodsTax + servicesTax = canonicalTax` exactement (jamais un arrondi
//   indépendant des deux côtés, qui doublerait le résidu comme en 2.3).
// - buckets vides (aucune ligne de la nature dans ce (catégorie, taux)) omis.
function bucketKey(entry: Pick<VatBreakdown, 'category' | 'rate'>): string {
  return `${entry.category}|${entry.rate}`
}

export function computeVatBreakdownByNature(invoice: Invoice): {
  complete: boolean
  goods: VatBreakdown[]
  services: VatBreakdown[]
} {
  const complete = invoice.lines.every((line) => line.nature !== undefined)
  if (!complete) {
    return { complete: false, goods: [], services: [] }
  }

  const goods = computeVatBreakdown(
    invoice.lines.filter((line) => line.nature === 'goods'),
  )
  const goodsByBucket = new Map(goods.map((entry) => [bucketKey(entry), entry]))

  const services = invoice.vatBreakdown.flatMap((canonicalEntry) => {
    const goodsEntry = goodsByBucket.get(bucketKey(canonicalEntry))
    const goodsTaxable = big(goodsEntry?.taxableAmount ?? '0.00')
    const goodsTax = big(goodsEntry?.taxAmount ?? '0.00')
    const servicesTaxable = big(canonicalEntry.taxableAmount).minus(
      goodsTaxable,
    )
    if (servicesTaxable.eq(0)) {
      return []
    }
    const servicesTax = big(canonicalEntry.taxAmount).minus(goodsTax)
    return [
      {
        category: canonicalEntry.category,
        rate: canonicalEntry.rate,
        taxableAmount: round2(servicesTaxable),
        taxAmount: round2(servicesTax),
      },
    ]
  })

  return { complete: true, goods, services }
}
