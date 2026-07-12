import { big, round2 } from './money.js'
import type { Invoice } from './schema.js'

export type RuleViolation = { rule: string; message: string }

// Sous-ensemble des règles métier EN 16931 (BR-CO-*, BR-S-*) pertinentes
// pour le périmètre v1 (pas de remises document ni d'acompte).
export function validateBusinessRules(invoice: Invoice): RuleViolation[] {
  const violations: RuleViolation[] = []
  const push = (rule: string, message: string) =>
    violations.push({ rule, message })

  const sumOfLines = round2(
    invoice.lines.reduce((acc, l) => acc.plus(l.lineNetAmount), big('0')),
  )
  if (sumOfLines !== invoice.totals.sumOfLines)
    push(
      'BR-CO-10',
      `sumOfLines ${invoice.totals.sumOfLines} != somme des lignes ${sumOfLines}`,
    )

  if (invoice.totals.taxExclusive !== invoice.totals.sumOfLines)
    push(
      'BR-CO-13',
      `taxExclusive ${invoice.totals.taxExclusive} != sumOfLines ${invoice.totals.sumOfLines}`,
    )

  const taxAmount = round2(
    invoice.vatBreakdown.reduce((acc, b) => acc.plus(b.taxAmount), big('0')),
  )
  if (taxAmount !== invoice.totals.taxAmount)
    push(
      'BR-CO-14',
      `taxAmount ${invoice.totals.taxAmount} != somme des TVA ${taxAmount}`,
    )

  const taxInclusive = round2(
    big(invoice.totals.taxExclusive).plus(invoice.totals.taxAmount),
  )
  if (taxInclusive !== invoice.totals.taxInclusive)
    push(
      'BR-CO-15',
      `taxInclusive ${invoice.totals.taxInclusive} != HT + TVA ${taxInclusive}`,
    )

  if (invoice.totals.payable !== invoice.totals.taxInclusive)
    push(
      'BR-CO-25',
      `payable ${invoice.totals.payable} != taxInclusive ${invoice.totals.taxInclusive}`,
    )

  for (const b of invoice.vatBreakdown) {
    const expected = round2(
      invoice.lines
        .filter((l) => l.vatCategory === b.category && l.vatRate === b.rate)
        .reduce((acc, l) => acc.plus(l.lineNetAmount), big('0')),
    )
    if (expected !== b.taxableAmount)
      push(
        'BR-S-08',
        `assiette ${b.taxableAmount} (${b.category} ${b.rate}%) != somme des lignes ${expected}`,
      )
    const expectedTax = round2(big(b.taxableAmount).times(b.rate).div(100))
    if (expectedTax !== b.taxAmount)
      push(
        'BR-CO-17',
        `TVA ${b.taxAmount} (${b.category} ${b.rate}%) != assiette × taux ${expectedTax}`,
      )
  }

  return violations
}
