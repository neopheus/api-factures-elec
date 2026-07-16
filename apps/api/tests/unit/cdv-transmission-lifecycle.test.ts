import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  CDV_TRANSMISSION_STATUS_META,
  canTransition,
  InvalidCdvTransmissionTransitionError,
  isCdvTransmissionStatus,
  isTerminal,
  motifRequired,
} from '../../src/cdv/cdv-transmission-lifecycle.js'

// ORACLE INDÉPENDANT (leçon T1, MEDIUM anti-tautologie appliquée DÈS le
// départ — cf. plan-3-1-review.md) : cette table est RETRANSCRITE À LA MAIN
// depuis le Step 1/Step 2 de la Task 3 du plan (docs/superpowers/plans/
// 2026-07-16-phase3-1-cdv-transmission-matrice.md lignes 377-379, D4 lignes
// 76-80) — elle n'importe PAS `ALLOWED` du module (non exporté, précisément
// pour empêcher ce genre de dérivation) et ne DOIT PAS être calculée à partir
// de `canTransition`. Toute divergence table de prod ↔ oracle ci-dessous fait
// échouer ce fichier.
const STATUSES = [
  'prepared',
  'transmitted',
  'parked',
  'acknowledged',
  'rejected',
] as const

const EXPECTED_TRANSITIONS: Record<
  (typeof STATUSES)[number],
  readonly string[]
> = {
  prepared: ['transmitted', 'parked', 'rejected'],
  transmitted: ['acknowledged', 'rejected'],
  parked: ['transmitted', 'rejected'], // reprise (T7) : adressabilité restaurée → renvoi
  acknowledged: [],
  rejected: [],
}

describe('cdv-transmission-lifecycle (machine de livraison CDV, D4 — DISTINCTE du CDV facture/e-reporting/annuaire)', () => {
  it('ancre le code RÉEL 601 sur rejected et code:null sur les 4 autres états (accept implicite, leçon 2.3-A3)', () => {
    expect(CDV_TRANSMISSION_STATUS_META.rejected.code).toBe(601)
    expect(CDV_TRANSMISSION_STATUS_META.prepared.code).toBeNull()
    expect(CDV_TRANSMISSION_STATUS_META.transmitted.code).toBeNull()
    expect(CDV_TRANSMISSION_STATUS_META.parked.code).toBeNull()
    // acknowledged = acceptation IMPLICITE (aucun code F6 d'acceptation
    // n'existe dans Annexe 2 — seul 601 « message CDV rejeté » est fourni,
    // D4) : code:null est donc la seule valeur honnête, pas une omission.
    expect(CDV_TRANSMISSION_STATUS_META.acknowledged.code).toBeNull()
  })

  it('autorise les 7 transitions nommées par le plan (Step 1)', () => {
    expect(canTransition('prepared', 'transmitted')).toBe(true)
    expect(canTransition('prepared', 'parked')).toBe(true)
    expect(canTransition('prepared', 'rejected')).toBe(true)
    expect(canTransition('transmitted', 'acknowledged')).toBe(true)
    expect(canTransition('transmitted', 'rejected')).toBe(true)
    expect(canTransition('parked', 'transmitted')).toBe(true)
    expect(canTransition('parked', 'rejected')).toBe(true)
  })

  it('parked → transmitted : reprise après adressabilité restaurée (T7, D6) — NON une auto-transition', () => {
    expect(canTransition('parked', 'transmitted')).toBe(true)
    expect(canTransition('parked', 'parked')).toBe(false)
  })

  it('parked → rejected : abandon de la reprise (échec persistant, sweep épuisé)', () => {
    expect(canTransition('parked', 'rejected')).toBe(true)
  })

  it('prepared → rejected : rejet LOCAL pré-envoi (F6 structurellement invalide, D4 désambiguïsation)', () => {
    expect(canTransition('prepared', 'rejected')).toBe(true)
  })

  it('transmitted → rejected : rejet PPF/réseau porteur du code 601 (D4 désambiguïsation)', () => {
    expect(canTransition('transmitted', 'rejected')).toBe(true)
  })

  it('parked est NON terminal (reprise T7) — distinct des deux vrais terminaux', () => {
    expect(isTerminal('parked')).toBe(false)
    expect(canTransition('parked', 'transmitted')).toBe(true)
    expect(canTransition('parked', 'rejected')).toBe(true)
  })

  it('acknowledged et rejected sont terminaux (aucune sortie, y compris entre eux)', () => {
    expect(isTerminal('acknowledged')).toBe(true)
    expect(isTerminal('rejected')).toBe(true)
    expect(canTransition('acknowledged', 'rejected')).toBe(false)
    expect(canTransition('rejected', 'acknowledged')).toBe(false)
  })

  it('prepared et transmitted ne sont pas terminaux', () => {
    expect(isTerminal('prepared')).toBe(false)
    expect(isTerminal('transmitted')).toBe(false)
  })

  it('exige un motif pour rejected (MDT-126, chaîne libre) et pour aucun autre état', () => {
    expect(motifRequired('rejected')).toBe(true)
    expect(motifRequired('prepared')).toBe(false)
    expect(motifRequired('transmitted')).toBe(false)
    expect(motifRequired('parked')).toBe(false)
    expect(motifRequired('acknowledged')).toBe(false)
  })

  it('assertTransition(acknowledged, transmitted) lève (terminal → non-terminal interdit)', () => {
    expect(() => assertTransition('acknowledged', 'transmitted')).toThrow(
      InvalidCdvTransmissionTransitionError,
    )
  })

  it('assertTransition lève avec from/to/name typés et un message explicite', () => {
    let caught: unknown
    try {
      assertTransition('rejected', 'transmitted')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(InvalidCdvTransmissionTransitionError)
    const typed = caught as InvalidCdvTransmissionTransitionError
    expect(typed.from).toBe('rejected')
    expect(typed.to).toBe('transmitted')
    expect(typed.name).toBe('InvalidCdvTransmissionTransitionError')
    expect(typed.message).toBe(
      'invalid cdv transmission transition: rejected → transmitted',
    )
  })

  it('assertTransition ne lève pas sur une transition valide', () => {
    expect(() => assertTransition('prepared', 'transmitted')).not.toThrow()
  })

  it('la table de prod correspond EXACTEMENT à l’oracle indépendant (anti-tautologie, ensembliste par statut)', () => {
    for (const from of STATUSES) {
      const declared = STATUSES.filter((to) => canTransition(from, to)).sort()
      expect(declared).toEqual([...EXPECTED_TRANSITIONS[from]].sort())
    }
  })

  it('autorise chaque arête de l’ORACLE et interdit tout le complément (5×5, les deux sens)', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const declared = EXPECTED_TRANSITIONS[from].includes(to)
        expect(canTransition(from, to)).toBe(declared)
      }
    }
  })

  it('interdit les self-loops pour tous les statuts', () => {
    for (const s of STATUSES) {
      expect(canTransition(s, s)).toBe(false)
    }
  })

  it('expose exactement les 5 statuts attendus (aucun ajout/oubli silencieux)', () => {
    expect(Object.keys(CDV_TRANSMISSION_STATUS_META).sort()).toEqual(
      [...STATUSES].sort(),
    )
  })

  it('rejette les propriétés héritées du prototype comme transition (garde anti-prototype)', () => {
    // @ts-expect-error entrée non fiable (ex. body de requête HTTP en Task 8)
    expect(canTransition('toString', 'prepared')).toBe(false)
    // @ts-expect-error idem
    expect(canTransition('prepared', 'constructor')).toBe(false)
  })

  it('isCdvTransmissionStatus reconnaît les 5 slugs valides et rejette le reste (garde anti-prototype, Task 8)', () => {
    for (const s of STATUSES) {
      expect(isCdvTransmissionStatus(s)).toBe(true)
    }
    expect(isCdvTransmissionStatus('unknown')).toBe(false)
    expect(isCdvTransmissionStatus('toString')).toBe(false)
    expect(isCdvTransmissionStatus('constructor')).toBe(false)
    expect(isCdvTransmissionStatus('hasOwnProperty')).toBe(false)
    expect(isCdvTransmissionStatus(601)).toBe(false)
    expect(isCdvTransmissionStatus(undefined)).toBe(false)
    expect(isCdvTransmissionStatus(null)).toBe(false)
  })
})
