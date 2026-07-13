import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import type { InvoiceInput } from '../../src/model/schema.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { simpleInvoiceInput } from '../fixtures.js'

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

describe('generateUbl', () => {
  const xml = () => generateUbl(buildInvoice(simpleInvoiceInput))

  it('produces a UBL Invoice document with the EN 16931 customization', () => {
    const out = xml()
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(out).toContain(
      'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    )
    expect(out).toContain(
      '<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID>',
    )
    expect(out).toContain('<cbc:ID>FA-2026-001</cbc:ID>')
  })

  it('carries the amounts with currency attributes', () => {
    const out = xml()
    expect(out).toContain(
      '<cbc:TaxAmount currencyID="EUR">200.00</cbc:TaxAmount>',
    )
    expect(out).toContain(
      '<cbc:PayableAmount currencyID="EUR">1200.00</cbc:PayableAmount>',
    )
    expect(out).toContain(
      '<cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity>',
    )
  })

  it('includes seller and buyer parties', () => {
    const out = xml()
    expect(out).toContain(
      '<cbc:RegistrationName>AV Digital</cbc:RegistrationName>',
    )
    expect(out).toContain('<cbc:CompanyID>FR32123456789</cbc:CompanyID>')
    expect(out).toContain(
      '<cbc:RegistrationName>Client SARL</cbc:RegistrationName>',
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
    const out = generateUbl(invoice)
    expect(out).toContain(
      '<cbc:TaxExemptionReason>Motif exonération sans code VATEX</cbc:TaxExemptionReason>',
    )
    expect(out).not.toContain('<cbc:TaxExemptionReasonCode>')
  })

  it('omits optional elements when address parts, vatId, siren and due date are absent', () => {
    const out = generateUbl(buildInvoice(minimalInvoiceInput))
    expect(out).not.toContain('<cbc:DueDate>')
    expect(out).not.toContain('<cbc:StreetName>')
    expect(out).not.toContain('<cbc:CityName>')
    expect(out).not.toContain('<cbc:PostalZone>')
    expect(out).not.toContain('<cac:PartyTaxScheme>')
    expect(out).not.toContain('<cbc:CompanyID>')
    expect(out).toContain(
      '<cbc:RegistrationName>Vendeur Minimal</cbc:RegistrationName>',
    )
    expect(out).toContain(
      '<cbc:RegistrationName>Acheteur Minimal</cbc:RegistrationName>',
    )
  })
})
