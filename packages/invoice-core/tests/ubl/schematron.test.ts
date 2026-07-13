import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { multiRateInvoiceInput, simpleInvoiceInput } from '../fixtures.js'
import { validateAgainstSchematron } from '../helpers/schematron.js'

describe('EN 16931 Schematron (official) on generated UBL', () => {
  it('passes for the simple invoice', () => {
    const result = validateAgainstSchematron(
      generateUbl(buildInvoice(simpleInvoiceInput)),
    )
    expect(result.failedAsserts).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('passes for the multi-rate invoice (exemption reason now present)', () => {
    const result = validateAgainstSchematron(
      generateUbl(buildInvoice(multiRateInvoiceInput)),
    )
    expect(result.failedAsserts.map((f) => f.id)).toEqual([])
    expect(result.valid).toBe(true)
  })

  it('detects BR-E-10 when the exemption reason is stripped', () => {
    const invoice = buildInvoice(multiRateInvoiceInput)
    const withoutReason = {
      ...invoice,
      vatBreakdown: invoice.vatBreakdown.map((b) =>
        b.category === 'E'
          ? {
              category: b.category,
              rate: b.rate,
              taxableAmount: b.taxableAmount,
              taxAmount: b.taxAmount,
            }
          : b,
      ),
    }
    const result = validateAgainstSchematron(generateUbl(withoutReason))
    expect(result.valid).toBe(false)
    expect(result.failedAsserts.map((f) => f.id)).toContain('BR-E-10')
  })

  it('stays Schematron-valid when a valid S line erroneously carries an exemption reason', () => {
    // Reproduit le scénario exact de la revue : une entrée valide dont une ligne S
    // porte un motif d'exonération (BT-120) ne doit plus produire d'UBL invalide —
    // le garde-fou du moteur (computeVatBreakdown) filtre le motif avant émission.
    const input = {
      ...simpleInvoiceInput,
      lines: [
        {
          ...simpleInvoiceInput.lines[0]!,
          exemptionReason: 'Motif ne devant pas apparaître (catégorie S)',
        },
      ],
    }
    const invoice = buildInvoice(input)
    expect(validateBusinessRules(invoice)).toEqual([])

    const result = validateAgainstSchematron(generateUbl(invoice))
    expect(result.failedAsserts).toEqual([])
    expect(result.valid).toBe(true)
  })
})
