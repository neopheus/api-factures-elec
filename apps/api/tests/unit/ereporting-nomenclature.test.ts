import { describe, expect, it } from 'vitest'
import {
  ISSUER_ROLES,
  mapCadreToCategories,
  REJECT_MOTIFS,
  SCHEME_ID_PA,
  SCHEME_ID_SIREN,
  SENDER_ROLE_PA,
  TRANSMISSION_TYPES,
  VAT_REGIMES,
} from '../../src/ereporting/nomenclature.js'

describe('nomenclatures Flux 10', () => {
  it('expose les codes réglementaires ancrés (Annexe 6 v1.10)', () => {
    expect(TRANSMISSION_TYPES).toEqual(['IN', 'RE'])
    expect(SENDER_ROLE_PA).toBe('WK') // UNCL 3035, émetteur PA (TT-10)
    expect(ISSUER_ROLES).toEqual(['BY', 'SE']) // déclarant acheteur/vendeur (TT-15)
    expect(SCHEME_ID_PA).toBe('0238') // ICD PA (TT-7)
    expect(SCHEME_ID_SIREN).toBe('0002') // SIREN (TT-12/33-1)
    expect(REJECT_MOTIFS).toEqual([
      'REJ_SEMAN',
      'REJ_UNI',
      'REJ_COH',
      'REJ_PER',
    ])
    expect(VAT_REGIMES).toContain('reel_normal_mensuel')
    expect(VAT_REGIMES).toContain('franchise')
  })

  it('mappe le cadre de facturation (BT-23) → catégorie(s) 10.3', () => {
    // Correspondance Annexe 6 « E-REPORTING - Correspondance ».
    expect(mapCadreToCategories('B1')).toEqual(['TLB1']) // livraison de biens
    expect(mapCadreToCategories('S1')).toEqual(['TPS1']) // prestation de services
    expect(mapCadreToCategories('M1')).toEqual(['TLB1', 'TPS1']) // mixte
    expect(mapCadreToCategories('B7')).toEqual(['TLB1'])
    expect(mapCadreToCategories('S6')).toEqual(['TPS1'])
  })

  it('couvre les 13 cadres BT-23 (aucun trou)', () => {
    const cadres = [
      'B1',
      'S1',
      'M1',
      'B2',
      'S2',
      'M2',
      'B4',
      'S4',
      'M4',
      'S5',
      'S6',
      'B7',
      'S7',
    ] as const
    for (const c of cadres)
      expect(mapCadreToCategories(c).length).toBeGreaterThan(0)
  })
})
