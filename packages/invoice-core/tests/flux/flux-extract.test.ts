import { describe, expect, it } from 'vitest'
import { MissingBusinessProcessTypeError } from '../../src/flux/errors.js'
import { generateFluxExtractUbl } from '../../src/flux/generate-extract.js'
import { buildInvoice } from '../../src/model/compute.js'
import type { InvoiceInput } from '../../src/model/schema.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import {
  F1_BASE_UBL_INVOICE_XSD,
  F1_FULL_UBL_INVOICE_XSD,
  validateAgainstXsd,
} from '../helpers/xsd.js'

const minimalInvoiceInput: InvoiceInput = {
  number: 'FA-2026-003',
  issueDate: '2026-07-12',
  typeCode: '380',
  currency: 'EUR',
  businessProcessType: 'S1',
  seller: {
    name: 'Vendeur Minimal',
    address: { countryCode: 'FR' },
  },
  buyer: {
    name: 'Acheteur Minimal',
    address: { countryCode: 'FR' },
  },
  lines: [
    {
      id: '1',
      name: 'Service',
      quantity: '1',
      unitCode: 'C62',
      unitPrice: '100.00',
      vatCategory: 'S',
      vatRate: '20.00',
    },
  ],
}

describe('generateFluxExtractUbl', () => {
  it('BASE validates against the DGFiP F1 BASE XSD (simple and multi-rate)', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstXsd(
        generateFluxExtractUbl(buildInvoice(input), 'BASE'),
        F1_BASE_UBL_INVOICE_XSD,
      )
      expect(r.errors).toBe('')
      expect(r.valid).toBe(true)
    }
  })

  it('FULL validates against the DGFiP F1 FULL XSD (simple and multi-rate)', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstXsd(
        generateFluxExtractUbl(buildInvoice(input), 'FULL'),
        F1_FULL_UBL_INVOICE_XSD,
      )
      expect(r.errors).toBe('')
      expect(r.valid).toBe(true)
    }
  })

  it('emits the mandatory ProfileID (BT-23/G1.02) and drops the forbidden monetary totals', () => {
    const xml = generateFluxExtractUbl(
      buildInvoice(multiRateInvoiceInput),
      'BASE',
    )
    expect(xml).toContain('<cbc:ProfileID>M1</cbc:ProfileID>')
    expect(xml).not.toContain('TaxInclusiveAmount')
    expect(xml).not.toContain('PayableAmount')
    expect(xml).toContain(
      '<cbc:TaxExclusiveAmount currencyID="EUR">409.87</cbc:TaxExclusiveAmount>',
    )
  })

  it('throws MissingBusinessProcessTypeError when BT-23 is absent (G1.02)', () => {
    const { businessProcessType: _omitted, ...withoutField } =
      simpleInvoiceInput
    const invoice = buildInvoice(withoutField)
    expect(() => generateFluxExtractUbl(invoice, 'BASE')).toThrow(
      MissingBusinessProcessTypeError,
    )
  })

  it('BASE carries no invoice lines', () => {
    const xml = generateFluxExtractUbl(
      buildInvoice(multiRateInvoiceInput),
      'BASE',
    )
    expect(xml).not.toContain('<cac:InvoiceLine>')
  })

  it('FULL keeps epured lines (no line id, no line net amount, no per-line VAT)', () => {
    const xml = generateFluxExtractUbl(
      buildInvoice(multiRateInvoiceInput),
      'FULL',
    )
    expect(xml).toContain('<cac:InvoiceLine>')
    expect(xml).not.toContain('<cac:ClassifiedTaxCategory>')
    expect(xml).toContain('<cbc:Name>Livre</cbc:Name>')
  })

  it('neither profile carries party names or registration names', () => {
    for (const profile of ['BASE', 'FULL'] as const) {
      const xml = generateFluxExtractUbl(
        buildInvoice(simpleInvoiceInput),
        profile,
      )
      expect(xml).not.toContain('<cac:PartyName>')
      expect(xml).not.toContain('<cbc:RegistrationName>')
    }
  })

  it('rejects a credit note (381)', () => {
    const creditNote = {
      ...buildInvoice(simpleInvoiceInput),
      typeCode: '381' as const,
    }
    expect(() => generateFluxExtractUbl(creditNote, 'BASE')).toThrow()
  })

  it('emits a free-text exemption reason without a code when only the text is given', () => {
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
    const xml = generateFluxExtractUbl(invoice, 'BASE')
    expect(xml).toContain(
      '<cbc:TaxExemptionReason>Motif exonération sans code VATEX</cbc:TaxExemptionReason>',
    )
    expect(xml).not.toContain('<cbc:TaxExemptionReasonCode>')
  })

  it('omits optional elements when address parts, vatId, siren and due date are absent', () => {
    for (const profile of ['BASE', 'FULL'] as const) {
      const xml = generateFluxExtractUbl(
        buildInvoice(minimalInvoiceInput),
        profile,
      )
      expect(xml).not.toContain('<cbc:DueDate>')
      expect(xml).not.toContain('<cbc:StreetName>')
      expect(xml).not.toContain('<cbc:CityName>')
      expect(xml).not.toContain('<cbc:PostalZone>')
      expect(xml).not.toContain('<cac:PartyTaxScheme>')
      expect(xml).not.toContain('<cac:PartyLegalEntity>')
    }
  })

  it('matches the frozen BASE golden (multi-rate)', () => {
    expectMatchesGolden(
      'flux-base-multi-rate.ubl.xml',
      generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'BASE'),
    )
  })

  it('matches the frozen FULL golden (multi-rate)', () => {
    expectMatchesGolden(
      'flux-full-multi-rate.ubl.xml',
      generateFluxExtractUbl(buildInvoice(multiRateInvoiceInput), 'FULL'),
    )
  })
})
