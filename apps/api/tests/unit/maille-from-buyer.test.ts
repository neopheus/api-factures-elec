import { describe, expect, it } from 'vitest'
import {
  BuyerIdentifierMissingError,
  buildMailleFromBuyer,
  isoDateToYmd,
  normalizeToUndefined,
} from '../../src/annuaire/maille-from-buyer.js'

// Tests migrés depuis cdv-transmission.service.test.ts (D5, plan 3.3 Task 2)
// — les fonctions pures Party -> Maille ont quitté le domaine CDV pour
// `annuaire/maille-from-buyer.ts`. Comportement inchangé (extraction
// byte-neutre) : ces vecteurs sont identiques à ceux du socle 3.1/3.2.
describe('isoDateToYmd', () => {
  it('convertit AAAA-MM-JJ -> AAAAMMJJ (retire les tirets)', () => {
    expect(isoDateToYmd('2026-07-16')).toBe('20260716')
  })
})

describe('normalizeToUndefined', () => {
  it('normalise la chaîne vide en undefined, laisse le reste intact', () => {
    expect(normalizeToUndefined('')).toBeUndefined()
    expect(normalizeToUndefined(undefined)).toBeUndefined()
    expect(normalizeToUndefined('123456789')).toBe('123456789')
  })
})

describe('buildMailleFromBuyer (amendement A4)', () => {
  it('SIREN (9 chiffres) -> { siren }, siret ABSENT (jamais vide)', () => {
    const maille = buildMailleFromBuyer({
      name: 'x',
      siren: '123456789',
      address: { countryCode: 'FR' },
    })
    expect(maille).toEqual({ siren: '123456789' })
    expect('siret' in maille).toBe(false)
  })

  it('SIRET (14 chiffres) -> { siren: 9 premiers chiffres, siret: valeur complète }', () => {
    const maille = buildMailleFromBuyer({
      name: 'x',
      siren: '12345678900014',
      address: { countryCode: 'FR' },
    })
    expect(maille).toEqual({
      siren: '123456789',
      siret: '12345678900014',
    })
  })

  it('buyer sans siren (undefined) -> BuyerIdentifierMissingError', () => {
    expect(() =>
      buildMailleFromBuyer({ name: 'x', address: { countryCode: 'FR' } }),
    ).toThrow(BuyerIdentifierMissingError)
  })

  it("buyer avec siren='' (coalesce trap, A4) -> BuyerIdentifierMissingError, PAS une maille siren=''", () => {
    expect(() =>
      buildMailleFromBuyer({
        name: 'x',
        siren: '',
        address: { countryCode: 'FR' },
      }),
    ).toThrow(BuyerIdentifierMissingError)
  })
})
