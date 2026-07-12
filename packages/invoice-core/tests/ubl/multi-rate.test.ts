import { describe, expect, it } from 'vitest'
import { buildInvoice } from '../../src/model/compute.js'
import { validateBusinessRules } from '../../src/model/rules.js'
import { generateUbl } from '../../src/ubl/generate.js'
import { multiRateInvoiceInput } from '../fixtures.js'
import { expectMatchesGolden } from '../helpers/golden.js'
import { validateAgainstXsd } from '../helpers/xsd.js'

describe('multi-rate invoice end to end', () => {
  const invoice = buildInvoice(multiRateInvoiceInput)

  it('satisfies every business rule', () => {
    expect(validateBusinessRules(invoice)).toEqual([])
  })

  it('validates against the official XSD', () => {
    const result = validateAgainstXsd(generateUbl(invoice))
    expect(result.errors).toBe('')
    expect(result.valid).toBe(true)
  })

  it('matches the frozen golden file', () => {
    expectMatchesGolden('invoice-multi-rate.ubl.xml', generateUbl(invoice))
  })
})
