import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { simpleInvoiceInput } from '../fixtures.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { validateAgainstXsd } from '../helpers/xsd.js'

describe('UBL output against the OASIS UBL 2.1 Invoice XSD', () => {
  it('validates the simple invoice against UBL-Invoice-2.1.xsd', () => {
    const result = validateAgainstXsd(
      generateUbl(buildInvoice(simpleInvoiceInput)),
    )
    expect(result.errors).toBe('')
    expect(result.valid).toBe(true)
  })

  it('matches the frozen golden file', () => {
    expectMatchesGolden(
      'invoice-simple.ubl.xml',
      generateUbl(buildInvoice(simpleInvoiceInput)),
    )
  })
})
