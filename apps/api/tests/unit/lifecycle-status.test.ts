import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  INITIAL_STATUS,
  InvalidLifecycleTransitionError,
  isLifecycleStatus,
  isTerminal,
  LIFECYCLE_STATUSES,
  requiresReason,
  STATUS_META,
  statusByCode,
} from '../../src/invoices/lifecycle-status.js'

describe('lifecycle-status (CDV state machine)', () => {
  it('exposes the 14 DGFiP statuses with codes 200..213', () => {
    expect(LIFECYCLE_STATUSES).toHaveLength(14)
    expect(STATUS_META.deposee).toEqual({
      code: 200,
      label: 'Déposée',
      mandatory: true,
    })
    expect(STATUS_META.refusee.code).toBe(210)
    expect(STATUS_META.encaissee).toEqual({
      code: 212,
      label: 'Encaissée',
      mandatory: true,
    })
    expect(STATUS_META.rejetee.code).toBe(213)
    // Socle obligatoire G7.44 = {200, 210, 212, 213}
    const mandatory = LIFECYCLE_STATUSES.filter((s) => STATUS_META[s].mandatory)
      .map((s) => STATUS_META[s].code)
      .sort((a, b) => a - b)
    expect(mandatory).toEqual([200, 210, 212, 213])
  })

  it('starts at Déposée (200)', () => {
    expect(INITIAL_STATUS).toBe('deposee')
    expect(STATUS_META[INITIAL_STATUS].code).toBe(200)
  })

  it('allows forward (strictly increasing code) transitions, skipping optionals', () => {
    expect(canTransition('deposee', 'emise')).toBe(true) // 200 → 201
    expect(canTransition('deposee', 'encaissee')).toBe(true) // 200 → 212 (saut d'optionnels)
    expect(canTransition('prise_en_charge', 'approuvee')).toBe(true) // 204 → 205
  })

  it('forbids backward and self transitions', () => {
    expect(canTransition('encaissee', 'deposee')).toBe(false) // 212 → 200
    expect(canTransition('approuvee', 'approuvee')).toBe(false) // self
    expect(canTransition('mise_a_disposition', 'emise')).toBe(false) // 203 → 201
  })

  it('treats Refusée and Rejetée as terminal (no outgoing transition)', () => {
    expect(isTerminal('refusee')).toBe(true)
    expect(isTerminal('rejetee')).toBe(true)
    expect(canTransition('refusee', 'rejetee')).toBe(false) // terminal, malgré 210<213
    expect(canTransition('rejetee', 'refusee')).toBe(false)
    expect(canTransition('encaissee', 'refusee')).toBe(false) // 212 → 210 (régression)
  })

  it('reaches the mandatory terminals from earlier statuses', () => {
    expect(canTransition('prise_en_charge', 'refusee')).toBe(true) // 204 → 210
    expect(canTransition('deposee', 'rejetee')).toBe(true) // 200 → 213
  })

  it('flags statuses requiring a reason comment (G7.25: refusée, suspendue)', () => {
    expect(requiresReason('refusee')).toBe(true)
    expect(requiresReason('suspendue')).toBe(true)
    expect(requiresReason('approuvee')).toBe(false)
  })

  it('assertTransition throws a typed error on an invalid transition', () => {
    expect(() => assertTransition('encaissee', 'deposee')).toThrow(
      InvalidLifecycleTransitionError,
    )
    expect(() => assertTransition('deposee', 'emise')).not.toThrow()
  })

  it('maps codes to slugs and guards unknown values', () => {
    expect(statusByCode(200)).toBe('deposee')
    expect(statusByCode(999)).toBeNull()
    expect(isLifecycleStatus('deposee')).toBe(true)
    expect(isLifecycleStatus('nope')).toBe(false)
  })

  // isLifecycleStatus() garde une entrée NON FIABLE (utilisée en aval par
  // Tasks 5/6 pour valider un statut reçu, ex. body de requête HTTP). `in`
  // traverse la chaîne de prototype : sans garde dédiée, ces noms hérités
  // d'Object.prototype seraient (à tort) reconnus comme des slugs valides,
  // faussant silencieusement canTransition/statusByCode en aval
  // (STATUS_META['toString'].code === undefined).
  it.each([
    'toString',
    'constructor',
    'hasOwnProperty',
    'valueOf',
  ])('rejects prototype-chain property %s as an unknown status', (name) => {
    expect(isLifecycleStatus(name)).toBe(false)
  })

  // A7 (amendement contrôleur) : le modèle monotone autorise explicitement
  // 212 (Encaissée) → 213 (Rejetée) — une facture encaissée peut être
  // ultérieurement rejetée (anomalie détectée après paiement). Cas
  // particulier car 212 et 213 sont tous deux « obligatoires » (G7.44) et
  // 213 est terminal ; 212 n'est PAS dans TERMINAL_STATUSES, donc la seule
  // règle qui s'applique est « code strictement croissant » (213 > 212).
  it('A7 : allows Encaissée (212) → Rejetée (213) — cas particulier documenté', () => {
    expect(isTerminal('encaissee')).toBe(false)
    expect(canTransition('encaissee', 'rejetee')).toBe(true)
    expect(() => assertTransition('encaissee', 'rejetee')).not.toThrow()
  })

  it('assertTransition throws with the from/to slugs attached', () => {
    let caught: unknown
    try {
      assertTransition('rejetee', 'deposee')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidLifecycleTransitionError)
    const typed = caught as InvalidLifecycleTransitionError
    expect(typed.from).toBe('rejetee')
    expect(typed.to).toBe('deposee')
    expect(typed.name).toBe('InvalidLifecycleTransitionError')
  })

  it('requiresReason is false for every other status (exhaustive sample)', () => {
    for (const status of LIFECYCLE_STATUSES) {
      if (status === 'refusee' || status === 'suspendue') continue
      expect(requiresReason(status)).toBe(false)
    }
  })

  it('every status is reachable in code order and TERMINAL_STATUSES matches isTerminal', () => {
    for (const status of LIFECYCLE_STATUSES) {
      expect(isTerminal(status)).toBe(
        status === 'refusee' || status === 'rejetee',
      )
    }
  })
})
