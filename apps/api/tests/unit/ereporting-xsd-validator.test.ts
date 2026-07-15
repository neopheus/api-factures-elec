import { describe, expect, it } from 'vitest'
import {
  EREPORTING_XSD_PATH,
  validateEreportingXml,
  XsdToolingError,
} from '../../src/ereporting/ereporting-xsd-validator.js'
import type { Flux10Report } from '../../src/ereporting/flux10-model.js'
import { generateEreportingXml } from '../../src/ereporting/flux10-xml.js'
import { EREPORTING_XSD as TEST_XSD_PATH } from '../helpers/ereporting-xsd.js'

// Helper PROD (Task 8, injection revue #6) — équivalent async/execFile du
// helper de test synchrone (tests/helpers/ereporting-xsd.ts, réservé aux
// tests unitaires de flux10-xml.ts). Distingue 3 issues, jamais confondues :
// valide / XSD-invalide (rejet sémantique) / outillage indisponible (throw).

const validReport: Flux10Report = {
  document: {
    id: 'TRX-UNIT-0001',
    issueDateTime: '20260921080000',
    typeCode: 'IN',
    sender: {
      id: 'PA01',
      schemeId: '0238',
      name: 'Factelec PA',
      roleCode: 'WK',
    },
    issuer: {
      id: '123456789',
      schemeId: '0002',
      name: 'Vendeur SARL',
      roleCode: 'SE',
    },
  },
  transactions: {
    periodStart: '20260901',
    periodEnd: '20260910',
    invoices: [],
    aggregated: [
      {
        date: '20260905',
        currency: 'EUR',
        categoryCode: 'TLB1',
        taxExclusiveAmount: '1000.00',
        taxTotal: '200.00',
        subtotals: [
          { taxPercent: '20.00', taxableAmount: '1000.00', taxTotal: '200.00' },
        ],
      },
    ],
  },
  payments: null,
}

describe('validateEreportingXml (PROD)', () => {
  it('résout le MÊME chemin XSD que le helper de test (dev/test/prod cohérents)', () => {
    expect(EREPORTING_XSD_PATH).toBe(TEST_XSD_PATH)
  })

  it('valide un flux XSD-conforme', async () => {
    const xml = generateEreportingXml(validReport)
    const result = await validateEreportingXml(xml)
    expect(result).toEqual({ valid: true, errors: '' })
  })

  it('rapporte un flux XSD-invalide comme un RÉSULTAT (pas une exception) — rejet sémantique', async () => {
    const result = await validateEreportingXml('<Report><Bogus/></Report>')
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("lève XsdToolingError (jamais un rejet sémantique) quand l'outil est indisponible (ENOENT)", async () => {
    let caught: unknown
    try {
      await validateEreportingXml('<Report/>', {
        binary: 'xmllint-does-not-exist-factelec-test',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(XsdToolingError)
    expect((caught as Error).name).toBe('XsdToolingError')
    expect((caught as Error).message).toContain(
      "libxml2 requis sur l'hôte worker",
    )
    expect((caught as Error & { cause?: unknown }).cause).toBeDefined()
  })

  it("XsdToolingError formate aussi une cause qui n'est PAS une Error (String(cause))", () => {
    const err = new XsdToolingError('raw string cause')
    expect(err.message).toContain('raw string cause')
    expect(err.cause).toBe('raw string cause')
  })
})
