import { describe, expect, it } from 'vitest'
import {
  assertTransition,
  canTransition,
  EREPORTING_STATUS_META,
  InvalidEreportingTransitionError,
  isEreportingStatus,
  isTerminal,
  motifRequired,
} from '../../src/ereporting/ereporting-lifecycle.js'

describe('machine à états e-reporting (300/301)', () => {
  it('ancre les codes réglementaires 300/301 et les codes null des états internes (A3)', () => {
    expect(EREPORTING_STATUS_META.deposee.code).toBe(300)
    expect(EREPORTING_STATUS_META.rejetee.code).toBe(301)
    // A3 : prepared/transmitted sont des états internes PA — 0/1 ne sont PAS
    // des codes DGFiP (seuls 300/301 le sont, Tableau 5). code doit être null.
    expect(EREPORTING_STATUS_META.prepared.code).toBeNull()
    expect(EREPORTING_STATUS_META.transmitted.code).toBeNull()
  })

  it('autorise prepared→transmitted→deposee et transmitted→rejetee', () => {
    expect(canTransition('prepared', 'transmitted')).toBe(true)
    expect(canTransition('transmitted', 'deposee')).toBe(true)
    expect(canTransition('transmitted', 'rejetee')).toBe(true)
  })

  it('interdit les transitions non prévues (y compris auto-transitions et sauts)', () => {
    expect(canTransition('prepared', 'deposee')).toBe(false)
    expect(canTransition('prepared', 'rejetee')).toBe(false)
    expect(canTransition('prepared', 'prepared')).toBe(false)
    expect(canTransition('transmitted', 'prepared')).toBe(false)
    expect(canTransition('transmitted', 'transmitted')).toBe(false)
  })

  it('interdit toute sortie des statuts terminaux 300/301', () => {
    expect(isTerminal('deposee')).toBe(true)
    expect(isTerminal('rejetee')).toBe(true)
    expect(isTerminal('prepared')).toBe(false)
    expect(isTerminal('transmitted')).toBe(false)
    expect(canTransition('deposee', 'rejetee')).toBe(false)
    expect(canTransition('rejetee', 'deposee')).toBe(false)
  })

  it('exige un motif pour un rejet (301) et pas pour les autres statuts', () => {
    expect(motifRequired('rejetee')).toBe(true)
    expect(motifRequired('deposee')).toBe(false)
    expect(motifRequired('prepared')).toBe(false)
    expect(motifRequired('transmitted')).toBe(false)
  })

  it('assertTransition lève sur une transition invalide', () => {
    expect(() => assertTransition('prepared', 'deposee')).toThrow(
      InvalidEreportingTransitionError,
    )
    let caught: unknown
    try {
      assertTransition('deposee', 'rejetee')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(InvalidEreportingTransitionError)
    expect((caught as InvalidEreportingTransitionError).from).toBe('deposee')
    expect((caught as InvalidEreportingTransitionError).to).toBe('rejetee')
    expect((caught as Error).message).toBe(
      'invalid e-reporting transition: deposee → rejetee',
    )
  })

  it('assertTransition ne lève pas sur une transition valide', () => {
    expect(() => assertTransition('prepared', 'transmitted')).not.toThrow()
  })

  it('isEreportingStatus reconnaît les slugs valides et rejette le reste (garde anti-prototype)', () => {
    expect(isEreportingStatus('prepared')).toBe(true)
    expect(isEreportingStatus('deposee')).toBe(true)
    expect(isEreportingStatus('rejetee')).toBe(true)
    expect(isEreportingStatus('unknown')).toBe(false)
    expect(isEreportingStatus('toString')).toBe(false)
    expect(isEreportingStatus('constructor')).toBe(false)
    expect(isEreportingStatus(42)).toBe(false)
    expect(isEreportingStatus(undefined)).toBe(false)
  })
})
