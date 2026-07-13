import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { UnsupportedTypeCodeError } from '../../src/ubl/errors.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { creditNoteInput, simpleInvoiceInput } from '../fixtures.js'

describe('generateUbl and the credit note type code', () => {
  it('still generates a UBL Invoice for type code 380', () => {
    const out = generateUbl(buildInvoice(simpleInvoiceInput))
    expect(out).toContain('<cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>')
  })

  it('throws UnsupportedTypeCodeError for a credit note (381)', () => {
    const creditNote = buildInvoice(creditNoteInput)
    expect(() => generateUbl(creditNote)).toThrow(UnsupportedTypeCodeError)
  })

  it('still computes totals for a credit note (only UBL emission is deferred)', () => {
    const creditNote = buildInvoice(creditNoteInput)
    expect(creditNote.totals.taxInclusive).toBe('1200.00')
  })
})
