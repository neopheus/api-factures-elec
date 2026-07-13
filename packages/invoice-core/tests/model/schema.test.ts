import { describe, expect, it } from 'vitest'
import {
  businessProcessTypeSchema,
  parseInvoiceInput,
} from '../../src/model/schema.js'
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

  it('rejects a well-formed but unknown VATEX code (BT-121)', () => {
    const bad = {
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          vatCategory: 'E',
          vatRate: '0.00',
          exemptionReasonCode: 'VATEX-EU-ZZZ99',
        },
      ],
    }
    expect(() => parseInvoiceInput(bad)).toThrow()
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

describe('businessProcessTypeSchema', () => {
  it.each([
    'B1',
    'S1',
    'M1',
    'S5',
    'S7',
  ] as const)('accepts the G1.02 code %s', (code) => {
    expect(businessProcessTypeSchema.parse(code)).toBe(code)
  })

  it('rejects a code outside the G1.02 nomenclature', () => {
    expect(() => businessProcessTypeSchema.parse('X1')).toThrow()
  })

  it('leaves businessProcessType optional on the invoice input', () => {
    const { businessProcessType: _omitted, ...withoutField } =
      simpleInvoiceInput
    expect(parseInvoiceInput(withoutField).businessProcessType).toBeUndefined()
  })

  it('accepts businessProcessType when a valid G1.02 code is given', () => {
    expect(
      parseInvoiceInput({ ...simpleInvoiceInput, businessProcessType: 'B2' })
        .businessProcessType,
    ).toBe('B2')
  })

  it('rejects businessProcessType when the code is outside the nomenclature', () => {
    expect(() =>
      parseInvoiceInput({ ...simpleInvoiceInput, businessProcessType: 'X1' }),
    ).toThrow()
  })
})
