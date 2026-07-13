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
        exemptionReasonCode: 'VATEX-EU-132-1I',
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

  it('merges lines sharing the same VAT category and rate into one breakdown entry', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      lines: [
        {
          id: '1',
          name: 'Ligne A',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '100.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
        {
          id: '2',
          name: 'Ligne B',
          quantity: '1',
          unitCode: 'C62',
          unitPrice: '50.00',
          vatCategory: 'S',
          vatRate: '20.00',
        },
      ],
    })
    expect(invoice.vatBreakdown).toEqual([
      {
        category: 'S',
        rate: '20.00',
        taxableAmount: '150.00',
        taxAmount: '30.00',
      },
    ])
  })

  it('propagates the exemption reason from the line to the VAT breakdown', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const exempt = invoice.vatBreakdown.find((b) => b.category === 'E')
    expect(exempt?.exemptionReasonCode).toBe('VATEX-EU-132-1I')
  })

  it('leaves standard-rate breakdowns without an exemption reason', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const standard = invoice.vatBreakdown.find((b) => b.category === 'S')
    expect(standard?.exemptionReasonCode).toBeUndefined()
    expect(standard?.exemptionReason).toBeUndefined()
  })

  it('propagates a free-text exemption reason when no VATEX code is given', () => {
    const invoice = buildInvoice({
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          vatCategory: 'E',
          vatRate: '0.00',
          exemptionReason: 'Motif exonération sans code VATEX',
        },
      ],
    })
    const exempt = invoice.vatBreakdown.find((b) => b.category === 'E')
    expect(exempt?.exemptionReason).toBe('Motif exonération sans code VATEX')
    expect(exempt?.exemptionReasonCode).toBeUndefined()
  })
})
