import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isVatexCode, VATEX_CODES } from '../../src/model/vatex.js'

const CODES_SCH = resolve(
  import.meta.dirname,
  '../../../../docs/reference/en16931-schematron/1.3.16/schematron/codelist/EN16931-CII-codes.sch',
)

describe('VATEX code membership', () => {
  it('accepts real VATEX codes (EU + FR) and rejects a well-formed but unknown one', () => {
    expect(isVatexCode('VATEX-EU-132-1I')).toBe(true)
    expect(isVatexCode('VATEX-EU-AE')).toBe(true)
    expect(isVatexCode('VATEX-FR-CNWVAT')).toBe(true) // avoir net de taxe (G6.21)
    expect(isVatexCode('VATEX-EU-ZZZ99')).toBe(false) // format valide, hors liste
  })

  it('stays in sync with the vendored BR-CL-22 whitelist (no missing/extra code)', () => {
    const sch = readFileSync(CODES_SCH, 'utf8')
    // Codes VATEX cités en dur dans l'assertion BR-CL-22 du Schematron CII.
    const codes = new Set(
      [...sch.matchAll(/VATEX-[A-Z]{2}-[A-Za-z0-9-]+/g)].map((m) => m[0]),
    )
    expect(codes.size).toBeGreaterThan(50)
    expect(codes).toEqual(VATEX_CODES)
  })
})
