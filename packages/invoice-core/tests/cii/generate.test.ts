import { describe, expect, it } from 'vitest'
import { generateCii } from '../../src/cii/generate.js'
import { buildInvoice } from '../../src/model/compute.js'
import type { InvoiceInput } from '../../src/model/schema.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { CII_SEF, validateAgainstSchematron } from '../helpers/schematron.js'
import { CII_D16B_XSD, validateAgainstXsd } from '../helpers/xsd.js'

// Mêmes minimalismes que tests/ubl/generate.test.ts::minimalInvoiceInput — pas de
// businessProcessType, pas de siren/vatId, pas d'adresse au-delà du pays requis :
// exerce les branches optionnelles de appendCiiParty/generateCii que les deux
// fixtures principales (toujours entièrement renseignées) ne prennent jamais.
const minimalInvoiceInput: InvoiceInput = {
  number: 'FA-2026-003',
  issueDate: '2026-07-12',
  typeCode: '380',
  currency: 'EUR',
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

describe('generateCii (CII D16B, EN 16931 profile)', () => {
  it('validates against the CII D16B XSD (simple and multi-rate)', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstXsd(
        generateCii(buildInvoice(input)),
        CII_D16B_XSD,
      )
      expect(r.errors).toBe('')
      expect(r.valid).toBe(true)
    }
  })

  it('passes the official EN 16931 CII Schematron', () => {
    for (const input of [simpleInvoiceInput, multiRateInvoiceInput]) {
      const r = validateAgainstSchematron(
        generateCii(buildInvoice(input)),
        CII_SEF,
      )
      expect(r.failedAsserts.map((f) => f.id)).toEqual([])
      expect(r.valid).toBe(true)
    }
  })

  it('carries the EN 16931 guideline and the document type code', () => {
    const xml = generateCii(buildInvoice(simpleInvoiceInput))
    expect(xml).toContain('<ram:ID>urn:cen.eu:en16931:2017</ram:ID>')
    expect(xml).toContain('<ram:TypeCode>380</ram:TypeCode>')
  })

  it('matches the CII goldens', () => {
    expectMatchesGolden(
      'cii-simple.xml',
      generateCii(buildInvoice(simpleInvoiceInput)),
    )
    expectMatchesGolden(
      'cii-multi-rate.xml',
      generateCii(buildInvoice(multiRateInvoiceInput)),
    )
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
    const out = generateCii(invoice)
    expect(out).toContain(
      '<ram:ExemptionReason>Motif exonération sans code VATEX</ram:ExemptionReason>',
    )
    expect(out).not.toContain('<ram:ExemptionReasonCode>')
  })

  it('omits optional elements and the business process context when absent', () => {
    const out = generateCii(buildInvoice(minimalInvoiceInput))
    expect(out).not.toContain(
      '<ram:BusinessProcessSpecifiedDocumentContextParameter>',
    )
    expect(out).not.toContain('<ram:SpecifiedLegalOrganization>')
    expect(out).not.toContain('<ram:SpecifiedTaxRegistration>')
    expect(out).not.toContain('<ram:PostcodeCode>')
    expect(out).not.toContain('<ram:LineOne>')
    expect(out).not.toContain('<ram:CityName>')
    expect(out).toContain('<ram:Name>Vendeur Minimal</ram:Name>')
    expect(out).toContain('<ram:Name>Acheteur Minimal</ram:Name>')
  })
})
