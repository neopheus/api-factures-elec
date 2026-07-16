import { describe, expect, it } from 'vitest'
import { dueSince, isPastDeadline } from '../../src/cdv/cdv-deadline.js'

// Fonctions pures de fenêtre/échéance de l'ordonnanceur CDV (Task 7,
// amendement A5) — AUCUN Date.now() : tous les vecteurs sont des dates
// fixes, injectées.
describe('cdv-deadline', () => {
  describe('dueSince', () => {
    it('renvoie now - lookbackMs (borne inférieure de la fenêtre bornée)', () => {
      const now = new Date('2026-07-16T12:00:00.000Z')
      expect(dueSince(now, 3_600_000)).toEqual(
        new Date('2026-07-16T11:00:00.000Z'),
      )
    })

    it('lookbackMs = 0 renvoie exactement now (fenêtre nulle)', () => {
      const now = new Date('2026-07-16T12:00:00.000Z')
      expect(dueSince(now, 0)).toEqual(now)
    })

    it('lookbackMs = 48h (défaut CDV_TRANSMISSION_LOOKBACK_MS) recule bien de 2 jours', () => {
      const now = new Date('2026-07-16T12:00:00.000Z')
      expect(dueSince(now, 172_800_000)).toEqual(
        new Date('2026-07-14T12:00:00.000Z'),
      )
    })
  })

  describe('isPastDeadline (échéance +24h, §3.6.6)', () => {
    const createdAt = new Date('2026-07-15T12:00:00.000Z')

    it('AVANT échéance (23h59m59s après création) -> false', () => {
      const now = new Date(createdAt.getTime() + 24 * 3_600_000 - 1_000)
      expect(isPastDeadline(createdAt, now)).toBe(false)
    })

    it('PILE à échéance (exactement +24h) -> true (limite atteinte = dépassée)', () => {
      const now = new Date(createdAt.getTime() + 24 * 3_600_000)
      expect(isPastDeadline(createdAt, now)).toBe(true)
    })

    it('APRÈS échéance (+24h1s) -> true', () => {
      const now = new Date(createdAt.getTime() + 24 * 3_600_000 + 1_000)
      expect(isPastDeadline(createdAt, now)).toBe(true)
    })
  })
})
