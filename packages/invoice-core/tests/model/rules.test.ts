import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import type { VatCategory } from '../../src/model/schema.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('validateBusinessRules', () => {
  it('returns no violation for computed invoices', () => {
    expect(validateBusinessRules(buildInvoice(simpleInvoiceInput))).toEqual([])
    expect(validateBusinessRules(buildInvoice(multiRateInvoiceInput))).toEqual(
      [],
    )
  })

  it('detects a tampered sum of lines (BR-CO-10)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      totals: { ...invoice.totals, sumOfLines: '999.00' },
    }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-CO-10')
  })

  it('detects a wrong tax inclusive amount (BR-CO-15)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      totals: { ...invoice.totals, taxInclusive: '1100.00' },
    }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-CO-15')
  })

  it('detects a VAT breakdown not matching the lines (BR-S-08)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      vatBreakdown: [{ ...invoice.vatBreakdown[0]!, taxableAmount: '500.00' }],
    }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-S-08')
  })

  it('detects a tampered total tax amount (BR-CO-14)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      totals: { ...invoice.totals, taxAmount: '150.00' },
    }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-CO-14')
  })

  it('reports the category-specific rule code for a tampered exempt breakdown (BR-E-08)', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const tampered = {
      ...invoice,
      vatBreakdown: invoice.vatBreakdown.map((b) =>
        b.category === 'E' ? { ...b, taxableAmount: '250.00' } : b,
      ),
    }
    const rules = validateBusinessRules(tampered).map((v) => v.rule)
    expect(rules).toContain('BR-E-08')
    expect(rules).not.toContain('BR-S-08')
  })

  it('detects a tax exclusive total diverging from the sum of lines (BR-CO-13)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      totals: { ...invoice.totals, taxExclusive: '900.00' },
    }
    expect(validateBusinessRules(tampered).map((v) => v.rule)).toContain(
      'BR-CO-13',
    )
  })

  it('detects a category tax amount not equal to base times rate (BR-CO-17)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      vatBreakdown: invoice.vatBreakdown.map((b) => ({
        ...b,
        taxAmount: '190.00',
      })),
    }
    expect(validateBusinessRules(tampered).map((v) => v.rule)).toContain(
      'BR-CO-17',
    )
  })

  it('detects a payable amount diverging from the tax inclusive total (BR-CO-25)', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    const tampered = {
      ...invoice,
      totals: { ...invoice.totals, payable: '1000.00' },
    }
    expect(validateBusinessRules(tampered).map((v) => v.rule)).toContain(
      'BR-CO-25',
    )
  })
})

const exemptionCases: ReadonlyArray<[VatCategory, string]> = [
  ['E', 'BR-E-10'],
  ['AE', 'BR-AE-10'],
  ['K', 'BR-IC-10'],
  ['G', 'BR-G-10'],
  ['O', 'BR-O-10'],
]

describe('exemption reason rules (BR-*-10)', () => {
  for (const [category, rule] of exemptionCases) {
    it(`flags ${rule} when a ${category} breakdown has no exemption reason`, () => {
      const base = buildInvoice(simpleInvoiceInput)
      const invoice = {
        ...base,
        lines: [{ ...base.lines[0]!, vatCategory: category, vatRate: '0.00' }],
        vatBreakdown: [
          {
            category,
            rate: '0.00',
            taxableAmount: base.lines[0]!.lineNetAmount,
            taxAmount: '0.00',
          },
        ],
        totals: {
          ...base.totals,
          taxAmount: '0.00',
          taxInclusive: base.totals.taxExclusive,
          payable: base.totals.taxExclusive,
        },
      }
      const rules = validateBusinessRules(invoice).map((v) => v.rule)
      expect(rules).toContain(rule)
    })
  }

  it('does not flag BR-E-10 when the exemption reason code is present', () => {
    const invoice = buildInvoice(multiRateInvoiceInput) // ligne E porte VATEX-EU-132-1I
    expect(validateBusinessRules(invoice).map((v) => v.rule)).not.toContain(
      'BR-E-10',
    )
  })
})
