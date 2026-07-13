import { big, round2 } from './money.js'
import type { Invoice, VatCategory } from './schema.js'

export type RuleViolation = { rule: string; message: string }

// EN 16931 : le code de règle de la vérification d'assiette (BR-*-08) dépend
// de la catégorie de TVA de la ligne de ventilation (BR-S-08, BR-Z-08, ...).
const taxableSumRuleByCategory: Record<VatCategory, string> = {
  S: 'BR-S-08',
  Z: 'BR-Z-08',
  E: 'BR-E-08',
  AE: 'BR-AE-08',
  K: 'BR-IC-08',
  G: 'BR-G-08',
  O: 'BR-O-08',
  L: 'BR-AF-08',
  M: 'BR-AG-08',
}

// EN 16931 : une ventilation TVA (BG-23) d'une catégorie exonérée doit porter
// un code de motif (BT-121) OU un texte de motif (BT-120). Le code de règle
// dépend de la catégorie.
const exemptionReasonRuleByCategory: Partial<Record<VatCategory, string>> = {
  E: 'BR-E-10',
  AE: 'BR-AE-10',
  K: 'BR-IC-10',
  G: 'BR-G-10',
  O: 'BR-O-10',
}

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
    const exemptionRule = exemptionReasonRuleByCategory[b.category]
    if (exemptionRule && !b.exemptionReasonCode && !b.exemptionReason)
      push(
        exemptionRule,
        `ventilation ${b.category} sans motif d'exonération (BT-120/BT-121 requis)`,
      )

    const expected = round2(
      invoice.lines
        .filter((l) => l.vatCategory === b.category && l.vatRate === b.rate)
        .reduce((acc, l) => acc.plus(l.lineNetAmount), big('0')),
    )
    if (expected !== b.taxableAmount)
      push(
        taxableSumRuleByCategory[b.category],
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
