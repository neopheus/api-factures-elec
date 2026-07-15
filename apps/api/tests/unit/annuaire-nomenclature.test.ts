import { describe, expect, it } from 'vitest'
import {
  DATE_RE,
  DIFFUSIBLE,
  FICTITIOUS_PLATFORM,
  isPlatformMatricule,
  MOTIF_PRESENCE,
  mailleLevelOf,
  NATURES,
  SCHEME_ID_SIREN,
  SCHEME_ID_SIRET,
  SIREN_RE,
  TYPE_FLUX,
} from '../../src/annuaire/nomenclature.js'

describe('nomenclatures annuaire (ANNEXE 3 v1.8 / Annuaire_Commun.xsd)', () => {
  it('expose les codes réglementaires ancrés', () => {
    expect(NATURES).toEqual(['D', 'M']) // Définition / Masquage (DT-7-2)
    expect(SCHEME_ID_SIREN).toBe('0002')
    expect(SCHEME_ID_SIRET).toBe('0009')
    expect(TYPE_FLUX).toEqual(['C', 'D']) // Complet / Différentiel (F14)
    expect(MOTIF_PRESENCE).toEqual(['C', 'P', 'S'])
    expect(DIFFUSIBLE).toEqual(['O', 'P', 'M'])
    expect(FICTITIOUS_PLATFORM).toBe('9998') // plateforme non-routante par défaut (§3.5.3)
  })

  it('valide les identifiants aux patterns du XSD commun', () => {
    expect(SIREN_RE.test('123456789')).toBe(true)
    expect(SIREN_RE.test('12345')).toBe(false)
    expect(DATE_RE.test('20260905')).toBe(true) // AAAAMMJJ
    expect(DATE_RE.test('20261305')).toBe(false) // mois 13
    expect(isPlatformMatricule('9998')).toBe(true)
    expect(isPlatformMatricule('99')).toBe(false)
  })

  it('déduit le niveau de maille (F13 row 25)', () => {
    expect(mailleLevelOf({ siren: '1'.repeat(9) })).toBe('SIREN')
    expect(mailleLevelOf({ siren: '1'.repeat(9), siret: '1'.repeat(14) })).toBe(
      'SIREN_SIRET',
    )
    expect(
      mailleLevelOf({
        siren: '1'.repeat(9),
        siret: '1'.repeat(14),
        routageId: 'SVC',
      }),
    ).toBe('SIREN_SIRET_ROUTAGE')
    expect(mailleLevelOf({ siren: '1'.repeat(9), suffixe: 'X' })).toBe(
      'SIREN_SUFFIXE',
    )
  })
})
