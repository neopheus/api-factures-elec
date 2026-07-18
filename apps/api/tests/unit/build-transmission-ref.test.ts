import { describe, expect, it } from 'vitest'
import { buildTransmissionRef } from '../../src/ereporting/ereporting-generation.service.js'

// Ref discriminé RE (plan 3.4, D3) : IN reste BYTE-IDENTIQUE (reSeq ignoré),
// RE gagne un suffixe `-${reSeq}`. Vecteurs FIXES, oracle indépendant (les
// refs attendus sont écrits en toutes lettres ci-dessous, jamais recalculés
// via l'implémentation elle-même — anti-tautologie, cf. plan Global
// Constraints).
const DECLARANT_ID = '11111111-2222-3333-4444-555555555555'
const PERIOD_START = '20260901'

describe('buildTransmissionRef — discriminant reSeq (RE), IN byte-identique', () => {
  it('IN sans reSeq → ER-<id8>-<period>-IN (byte-identique à l’existant)', () => {
    expect(buildTransmissionRef(DECLARANT_ID, PERIOD_START, 'IN')).toBe(
      'ER-11111111-20260901-IN',
    )
  })

  it('RE avec reSeq=0 → ER-<id8>-<period>-RE-0', () => {
    expect(buildTransmissionRef(DECLARANT_ID, PERIOD_START, 'RE', 0)).toBe(
      'ER-11111111-20260901-RE-0',
    )
  })

  it('RE avec reSeq=3 → …-RE-3 (≤ 50 chars)', () => {
    const ref = buildTransmissionRef(DECLARANT_ID, PERIOD_START, 'RE', 3)
    expect(ref).toBe('ER-11111111-20260901-RE-3')
    expect(ref.length).toBeLessThanOrEqual(50)
  })

  it('IN ignore reSeq (défense : reSeq fourni mais type=IN → pas de suffixe)', () => {
    expect(buildTransmissionRef(DECLARANT_ID, PERIOD_START, 'IN', 7)).toBe(
      'ER-11111111-20260901-IN',
    )
  })
})
