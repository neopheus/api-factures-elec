import { describe, expect, it } from 'vitest'
import {
  ANNUAIRE_CONSULTATION_XSD_PATH,
  AnnuaireXsdToolingError,
  validateAnnuaireConsultationXml,
} from '../../src/annuaire/annuaire-xsd-validator.js'
import { ANNUAIRE_CONSULTATION_XSD as TEST_XSD_PATH } from '../helpers/annuaire-xsd.js'

// Miroir tests/unit/ereporting-xsd-validator.test.ts (helper PROD async, cf.
// annuaire-xsd-validator.ts) — distingue valide / XSD-invalide (résultat) /
// outillage indisponible (throw), jamais confondus.

const validF14 = `<?xml version="1.0" encoding="UTF-8"?>
<AnnuaireConsultationF14>
  <HorodateProduction>20260910120000</HorodateProduction>
  <TypeFlux>C</TypeFlux>
</AnnuaireConsultationF14>`

describe('validateAnnuaireConsultationXml (PROD)', () => {
  it('résout le MÊME chemin XSD que le helper de test (dev/test/prod cohérents)', () => {
    expect(ANNUAIRE_CONSULTATION_XSD_PATH).toBe(TEST_XSD_PATH)
  })

  it('valide un F14 XSD-conforme', async () => {
    const result = await validateAnnuaireConsultationXml(validF14)
    expect(result).toEqual({ valid: true, errors: '' })
  })

  it('rapporte un F14 XSD-invalide comme un RÉSULTAT (pas une exception) — rejet sémantique', async () => {
    const result = await validateAnnuaireConsultationXml(
      '<AnnuaireConsultationF14><Bogus/></AnnuaireConsultationF14>',
    )
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("lève AnnuaireXsdToolingError (jamais un rejet sémantique) quand l'outil est indisponible (ENOENT)", async () => {
    let caught: unknown
    try {
      await validateAnnuaireConsultationXml(validF14, {
        binary: 'xmllint-does-not-exist-factelec-test',
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AnnuaireXsdToolingError)
    expect((caught as Error).name).toBe('AnnuaireXsdToolingError')
    expect((caught as Error).message).toContain("libxml2 requis sur l'hôte")
    expect((caught as Error & { cause?: unknown }).cause).toBeDefined()
  })

  it("AnnuaireXsdToolingError formate aussi une cause qui n'est PAS une Error (String(cause))", () => {
    const err = new AnnuaireXsdToolingError('raw string cause')
    expect(err.message).toContain('raw string cause')
    expect(err.cause).toBe('raw string cause')
  })
})
