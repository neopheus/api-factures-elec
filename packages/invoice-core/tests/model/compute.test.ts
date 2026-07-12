import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('buildInvoice', () => {
  it('computes line net amounts, VAT breakdown and totals for a simple invoice', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    expect(invoice.lines[0]!.lineNetAmount).toBe('1000.00')
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '1000.00',
        taxAmount: '200.00',
      },
    ])
    expect(invoice.totals).toEqual({
      sumOfLines: '1000.00',
      taxExclusive: '1000.00',
      taxAmount: '200.00',
      taxInclusive: '1200.00',
      payable: '1200.00',
    })
  })

  it('groups the VAT breakdown by category and rate', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    // 3 × 19.99 = 59.97 (S 5.50) ; 49.90 (S 20.00) ; 2 × 150.00 = 300.00 (E 0.00)
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'S',
        rate: '5.50',
        taxableAmount: '59.97',
        taxAmount: '3.30',
      },
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '49.90',
        taxAmount: '9.98',
      },
      {
        category: 'E',
        rate: '0.00',
        taxableAmount: '300.00',
        taxAmount: '0.00',
      },
    ])
    expect(invoice.totals).toEqual({
      sumOfLines: '409.87',
      taxExclusive: '409.87',
      taxAmount: '13.28',
      taxInclusive: '423.15',
      payable: '423.15',
    })
  })

  it('returns an invoice that satisfies the full invoice schema', () => {
    const invoice = buildInvoice(simpleInvoiceInput)
    expect(invoice.number).toBe('FA-2026-001')
    expect(invoice.seller.name).toBe('AV Digital')
  })
})
