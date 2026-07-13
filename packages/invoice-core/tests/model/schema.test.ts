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

  it('rejects impossible calendar dates', () => {
    expect(() =>
      parseInvoiceInput({ ...simpleInvoiceInput, issueDate: '2026-02-31' }),
    ).toThrow()
    expect(() =>
      parseInvoiceInput({ ...simpleInvoiceInput, issueDate: '2026-02-29' }),
    ).toThrow()
  })

  it('accepts a leap-day issue date', () => {
    expect(
      parseInvoiceInput({ ...simpleInvoiceInput, issueDate: '2028-02-29' })
        .issueDate,
    ).toBe('2028-02-29')
  })

  it('rejects a negative quantity', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0]!, quantity: '-1' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects a negative unit price', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0]!, unitPrice: '-10.00' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('rejects a negative VAT rate', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [{ ...simpleInvoiceInput.lines[0]!, vatRate: '-20.00' }],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
  })

  it('accepts a credit note type code (381)', () => {
    expect(
      parseInvoiceInput({ ...simpleInvoiceInput, typeCode: '381' }).typeCode,
    ).toBe('381')
  })

  it('accepts an exemption reason code and text on a line', () => {
    const withReason = {
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          vatCategory: 'E',
          vatRate: '0.00',
          exemptionReasonCode: 'VATEX-EU-132-1I',
          exemptionReason: 'Formation professionnelle exonérée',
        },
      ],
    }
    const parsed = parseInvoiceInput(withReason)
    expect(parsed.lines[0]!.exemptionReasonCode).toBe('VATEX-EU-132-1I')
    expect(parsed.lines[0]!.exemptionReason).toBe(
      'Formation professionnelle exonérée',
    )
  })
})
