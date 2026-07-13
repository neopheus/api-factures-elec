import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { big, round2 } from '../../src/model/money.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import { parseInvoiceInput } from '../../src/model/schema.js'
import { simpleInvoiceInput } from '../fixtures.js'

// Générateurs seedés d'entrées VALIDES (montants positifs à 2 décimales, taux réels).
const amount2 = fc
  .tuple(fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 99 }))
  .map(([euros, cents]) => `${euros}.${String(cents).padStart(2, '0')}`)
  .filter((a) => a !== '0.00')

const quantity = fc.integer({ min: 1, max: 100 }).map(String)

const taxedCategory = fc.constantFrom(
  { vatCategory: 'S' as const, vatRate: '20.00' },
  { vatCategory: 'S' as const, vatRate: '10.00' },
  { vatCategory: 'S' as const, vatRate: '5.50' },
  { vatCategory: 'Z' as const, vatRate: '0.00' },
)

const taxedInvoice = fc
  .array(fc.record({ quantity, unitPrice: amount2, cat: taxedCategory }), {
    minLength: 1,
    maxLength: 8,
  })
  .map((rows) => ({
    ...simpleInvoiceInput,
    lines: rows.map((r, i) => ({
      id: String(i + 1),
      name: `Ligne ${i + 1}`,
      quantity: r.quantity,
      unitCode: 'C62',
      unitPrice: r.unitPrice,
      vatCategory: r.cat.vatCategory,
      vatRate: r.cat.vatRate,
    })),
  }))

const exemptInvoice = fc
  .array(fc.record({ quantity, unitPrice: amount2 }), {
    minLength: 1,
    maxLength: 5,
  })
  .map((rows) => ({
    ...simpleInvoiceInput,
    lines: rows.map((r, i) => ({
      id: String(i + 1),
      name: `Exonéré ${i + 1}`,
      quantity: r.quantity,
      unitCode: 'C62',
      unitPrice: r.unitPrice,
      vatCategory: 'E' as const,
      vatRate: '0.00',
      exemptionReasonCode: 'VATEX-EU-132-1I',
    })),
  }))

describe('invoice engine invariants (property-based, seeded)', () => {
  it('reconciles totals and satisfies every business rule', () => {
    fc.assert(
      fc.property(taxedInvoice, (input) => {
        const inv = buildInvoice(parseInvoiceInput(input))
        // arrondis : tous les montants sont formatés à 2 décimales exactes
        expect(inv.totals.sumOfLines).toMatch(/^\d+\.\d{2}$/)
        // BR-CO-10 / BR-CO-13 : somme des lignes = HT = taxExclusive
        const sum = round2(
          inv.lines.reduce((a, l) => a.plus(l.lineNetAmount), big('0')),
        )
        expect(sum).toBe(inv.totals.sumOfLines)
        expect(inv.totals.taxExclusive).toBe(inv.totals.sumOfLines)
        // BR-CO-14 : TVA totale = somme des TVA de ventilation
        const tax = round2(
          inv.vatBreakdown.reduce((a, b) => a.plus(b.taxAmount), big('0')),
        )
        expect(tax).toBe(inv.totals.taxAmount)
        // BR-CO-15 : TTC = HT + TVA
        expect(
          round2(big(inv.totals.taxExclusive).plus(inv.totals.taxAmount)),
        ).toBe(inv.totals.taxInclusive)
        // round-trip build → rules : aucune violation
        expect(validateBusinessRules(inv)).toEqual([])
      }),
      { seed: 20260713, numRuns: 300 },
    )
  })

  it('groups the VAT breakdown so that taxable amounts reconcile per (category, rate)', () => {
    fc.assert(
      fc.property(taxedInvoice, (input) => {
        const inv = buildInvoice(parseInvoiceInput(input))
        for (const b of inv.vatBreakdown) {
          const expected = round2(
            inv.lines
              .filter(
                (l) => l.vatCategory === b.category && l.vatRate === b.rate,
              )
              .reduce((a, l) => a.plus(l.lineNetAmount), big('0')),
          )
          expect(b.taxableAmount).toBe(expected)
        }
      }),
      { seed: 424242, numRuns: 300 },
    )
  })

  it('never flags BR-E-10 when exempt lines carry a VATEX code', () => {
    fc.assert(
      fc.property(exemptInvoice, (input) => {
        const inv = buildInvoice(parseInvoiceInput(input))
        expect(validateBusinessRules(inv).map((v) => v.rule)).not.toContain(
          'BR-E-10',
        )
      }),
      { seed: 7, numRuns: 100 },
    )
  })

  it('is deterministic: building twice yields identical totals', () => {
    fc.assert(
      fc.property(taxedInvoice, (input) => {
        const parsed = parseInvoiceInput(input)
        expect(buildInvoice(parsed).totals).toEqual(buildInvoice(parsed).totals)
      }),
      { seed: 1, numRuns: 100 },
    )
  })
})
