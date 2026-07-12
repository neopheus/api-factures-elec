import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { validateBusinessRules } from '../../src/model/rules.js'
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
})
