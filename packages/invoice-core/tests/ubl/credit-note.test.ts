import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { creditNoteInput, simpleInvoiceInput } from '../fixtures.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { validateAgainstSchematron } from '../helpers/schematron.js'
import { OASIS_UBL_CREDITNOTE_XSD, validateAgainstXsd } from '../helpers/xsd.js'

describe('generateUbl routing (Invoice 380 / CreditNote 381)', () => {
  it('still generates a UBL Invoice for type code 380', () => {
    const out = generateUbl(buildInvoice(simpleInvoiceInput))
    expect(out).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
    expect(out).toContain('<cac:InvoiceLine>')
  })

  it('emits cbc:ProfileID (BT-23) between CustomizationID and ID on an Invoice', () => {
    const out = generateUbl(buildInvoice(simpleInvoiceInput))
    expect(out).toContain('<cbc:ProfileID>S1</cbc:ProfileID>')
    const customizationIdx = out.indexOf('<cbc:CustomizationID>')
    const profileIdx = out.indexOf('<cbc:ProfileID>')
    const idIdx = out.indexOf('<cbc:ID>')
    expect(customizationIdx).toBeLessThan(profileIdx)
    expect(profileIdx).toBeLessThan(idIdx)
  })

  it('omits cbc:ProfileID on an Invoice without businessProcessType', () => {
    const { businessProcessType: _omitted, ...withoutField } =
      simpleInvoiceInput
    const out = generateUbl(buildInvoice(withoutField))
    expect(out).not.toContain('<cbc:ProfileID>')
  })

  it('generates a UBL CreditNote for type code 381', () => {
    const out = generateUbl(buildInvoice(creditNoteInput))
    expect(out).toContain(
      'xmlns="urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2"',
    )
    expect(out).toContain(
      '<cbc:CreditNoteTypeCode>381</cbc:CreditNoteTypeCode>',
    )
    expect(out).toContain('<cac:CreditNoteLine>')
    expect(out).toContain(
      '<cbc:CreditedQuantity unitCode="C62">1</cbc:CreditedQuantity>',
    )
    // pas de cbc:DueDate dans un CreditNote (absent du CreditNoteType OASIS)
    expect(out).not.toContain('<cbc:DueDate>')
    expect(out).not.toContain('<cbc:InvoiceTypeCode>')
  })

  it('emits cbc:ProfileID (BT-23) between CustomizationID and ID on a CreditNote', () => {
    const out = generateUbl(buildInvoice(creditNoteInput))
    expect(out).toContain('<cbc:ProfileID>S1</cbc:ProfileID>')
    const customizationIdx = out.indexOf('<cbc:CustomizationID>')
    const profileIdx = out.indexOf('<cbc:ProfileID>')
    const idIdx = out.indexOf('<cbc:ID>')
    expect(customizationIdx).toBeLessThan(profileIdx)
    expect(profileIdx).toBeLessThan(idIdx)
  })

  it('omits cbc:ProfileID on a CreditNote without businessProcessType', () => {
    const { businessProcessType: _omitted, ...withoutField } = creditNoteInput
    const out = generateUbl(buildInvoice(withoutField))
    expect(out).not.toContain('<cbc:ProfileID>')
  })

  it('produces a CreditNote valid against the OASIS CreditNote XSD', () => {
    const r = validateAgainstXsd(
      generateUbl(buildInvoice(creditNoteInput)),
      OASIS_UBL_CREDITNOTE_XSD,
    )
    expect(r.errors).toBe('')
    expect(r.valid).toBe(true)
  })

  it('produces a CreditNote passing the official EN 16931 Schematron', () => {
    const r = validateAgainstSchematron(
      generateUbl(buildInvoice(creditNoteInput)),
    )
    expect(r.failedAsserts.map((f) => f.id)).toEqual([])
    expect(r.valid).toBe(true)
  })

  it('matches the credit note golden', () => {
    expectMatchesGolden(
      'credit-note-simple.ubl.xml',
      generateUbl(buildInvoice(creditNoteInput)),
    )
  })
})
