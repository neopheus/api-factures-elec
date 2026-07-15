import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeStatusEvent,
  computeEventHash,
  genesisHash,
  type StatusEventForHash,
} from '../../src/ledger/ledger-hash.js'

const base: StatusEventForHash = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  invoiceId: '22222222-2222-2222-2222-222222222222',
  seq: 1,
  fromStatus: null,
  toStatus: 'deposee',
  actor: 'platform',
  reason: null,
  createdAtMs: 0,
}

describe('ledger-hash (canonicalisation & scellement)', () => {
  it('canonicalise avec un encodage longueur-préfixé figé (vecteur constant)', () => {
    // Vecteur calculé à la main : field(v)= v===null?'-1|':octetLen+'|'+v, ordre figé.
    expect(canonicalizeStatusEvent(base)).toBe(
      '36|11111111-1111-1111-1111-111111111111' +
        '36|22222222-2222-2222-2222-222222222222' +
        '1|1' +
        '-1|' +
        '7|deposee' +
        '8|platform' +
        '-1|' +
        '1|0',
    )
  })

  it('est injection-proof : un | dans reason ne casse pas le découpage', () => {
    const a = canonicalizeStatusEvent({ ...base, reason: 'a|b' })
    const b = canonicalizeStatusEvent({
      ...base,
      reason: 'a',
      actor: 'platform|b',
    })
    expect(a).not.toBe(b) // la longueur préfixée dissocie les deux
    expect(a).toContain('3|a|b')
  })

  it('compte les octets UTF-8, pas les caractères', () => {
    // 'é' = 2 octets UTF-8 → préfixe 2, pas 1.
    expect(canonicalizeStatusEvent({ ...base, actor: 'é' })).toContain('2|é')
  })

  it("distingue la chaîne vide ('0|') de null ('-1|')", () => {
    // Contrat miroir (revue Task 2 INFO #4) : '' n'est PAS null. Le champ
    // reason précède immédiatement createdAtMs ('1|0') dans l'ordre figé.
    expect(canonicalizeStatusEvent({ ...base, reason: '' })).toMatch(/0\|1\|0$/)
    expect(canonicalizeStatusEvent({ ...base, reason: null })).toMatch(
      /-1\|1\|0$/,
    )
    expect(canonicalizeStatusEvent({ ...base, reason: '' })).not.toBe(
      canonicalizeStatusEvent({ ...base, reason: null }),
    )
  })

  it('assimile undefined à null (robustesse au bord de désérialisation)', () => {
    // Hors contrat (l'interface impose null), mais un consommateur reconstruisant
    // depuis une ligne DB non typée pourrait obtenir undefined : field() le scelle
    // comme null ('-1|') plutôt que de lever un TypeError opaque (revue Task 3 F1).
    const withUndef = {
      ...base,
      fromStatus: undefined as unknown as null,
      reason: undefined as unknown as null,
    }
    expect(canonicalizeStatusEvent(withUndef)).toBe(
      canonicalizeStatusEvent(base),
    )
  })

  it('genesisHash : 32 octets, déterministe, distinct par tenant', () => {
    const g1 = genesisHash(base.tenantId)
    expect(g1).toHaveLength(32)
    expect(g1.equals(genesisHash(base.tenantId))).toBe(true)
    expect(g1.equals(genesisHash('33333333-3333-3333-3333-333333333333'))).toBe(
      false,
    )
    // Ancre externe : genesis = sha256('factelec:ledger:genesis:v1:'||tenantId).
    expect(g1.toString('hex')).toBe(
      createHash('sha256')
        .update(`factelec:ledger:genesis:v1:${base.tenantId}`, 'utf8')
        .digest('hex'),
    )
  })

  it('computeEventHash : 32 octets, déterministe, avalanche sur tout champ', () => {
    const prev = genesisHash(base.tenantId)
    const h = computeEventHash(prev, base)
    expect(h).toHaveLength(32)
    expect(h.equals(computeEventHash(prev, base))).toBe(true)
    // Changer un seul champ change le hash.
    expect(h.equals(computeEventHash(prev, { ...base, actor: 'user:x' }))).toBe(
      false,
    )
    expect(h.equals(computeEventHash(prev, { ...base, seq: 2 }))).toBe(false)
    expect(h.equals(computeEventHash(prev, { ...base, createdAtMs: 1 }))).toBe(
      false,
    )
    // Changer le maillon précédent change le hash (chaînage réel).
    const prev2 = genesisHash('44444444-4444-4444-4444-444444444444')
    expect(h.equals(computeEventHash(prev2, base))).toBe(false)
  })
})
