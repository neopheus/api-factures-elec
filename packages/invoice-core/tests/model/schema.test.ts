import { describe, expect, it } from 'vitest'
import { parseInvoiceInput } from '../../src/model/schema.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'

describe('parseInvoiceInput', () => {
  it('accepts a valid simple invoice input', () => {
    expect(parseInvoiceInput(simpleInvoiceInput)).toEqual(simpleInvoiceInput)
  })

  it('accepts a valid multi-rate invoice input', () => {
    expect(parseInvoiceInput(multiRateInvoiceInput)).toEqual(
      multiRateInvoiceInput,
    )
  })

  it('rejects an invalid currency code', () => {
    expect(() =>
      parseInvoiceInput({ ...simpleInvoiceInput, currency: 'euro' }),
    ).toThrow()
  })

  it('rejects an invalid SIREN', () => {
    const bad = {
      ...simpleInvoiceInput,
      seller: { ...simpleInvoiceInput.seller, siren: '12AB' },
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects an invoice without lines', () => {
    expect(() =>
      parseInvoiceInput({ ...simpleInvoiceInput, lines: [] }),
    ).toThrow()
  })

  it('rejects a malformed issue date', () => {
    expect(() =>
      parseInvoiceInput({ ...simpleInvoiceInput, issueDate: '12/07/2026' }),
    ).toThrow()
  })

  it('rejects a unit price with more than 4 decimals', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0], unitPrice: '10.00001' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects an unknown VAT category', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0], vatCategory: 'X' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })
})
