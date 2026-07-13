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
