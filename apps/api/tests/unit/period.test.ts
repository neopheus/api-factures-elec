import { describe, expect, it } from 'vitest'
import { VAT_REGIMES } from '../../src/ereporting/nomenclature.js'
import {
  CADENCE_BY_REGIME,
  computeDuePeriods,
  MAX_DUE_PERIODS,
} from '../../src/ereporting/period.js'

// Vecteurs sur dates FIXES (Date UTC), alignés sur le Tableau 13 VERBATIM
// (§3.7.7 — cf. research-2-3-questions.md ; revue T7). Interprétation projet
// résiduelle : « 8h00 » modélisé à 08:00 UTC (cf. bandeau de period.ts).
describe('computeDuePeriods', () => {
  it('réel normal mensuel : décades 1-10 / 11-20 / 21-fin', () => {
    // Au 21/09, la 1ère décade (01-10/09) est échue (deadline le 21 à 08:00).
    const due = computeDuePeriods(
      'reel_normal_mensuel',
      new Date(Date.UTC(2026, 8, 21, 9)),
    )
    expect(due).toContainEqual({
      periodStart: '20260901',
      periodEnd: '20260910',
    })
  })

  it('réel normal mensuel : la décade 11-20 et 21-fin du même mois ne sont PAS encore échues', () => {
    const due = computeDuePeriods(
      'reel_normal_mensuel',
      new Date(Date.UTC(2026, 8, 21, 9)),
    )
    expect(due).not.toContainEqual({
      periodStart: '20260911',
      periodEnd: '20260920',
    })
    expect(due).not.toContainEqual({
      periodStart: '20260921',
      periodEnd: '20260930',
    })
  })

  it('réel normal mensuel : juste avant la deadline (08:00 pile), la décade 1-10 n’est PAS encore échue', () => {
    const due = computeDuePeriods(
      'reel_normal_mensuel',
      new Date(Date.UTC(2026, 8, 21, 7, 59, 59)),
    )
    expect(due).not.toContainEqual({
      periodStart: '20260901',
      periodEnd: '20260910',
    })
  })

  it('réel normal mensuel : à la deadline pile (21 à 08:00), la décade 1-10 EST échue', () => {
    const due = computeDuePeriods(
      'reel_normal_mensuel',
      new Date(Date.UTC(2026, 8, 21, 8, 0, 0)),
    )
    expect(due).toContainEqual({
      periodStart: '20260901',
      periodEnd: '20260910',
    })
  })

  // Tableau 13 VERBATIM (revue T7) : franchise = « le 1er du 2E mois suivant
  // la période » → le bimestre sept-oct (fin 31/10) est échu le 01/12 à 08:00.
  it('franchise en base : bimestres civils, échéance fin de bimestre + 2 mois', () => {
    const due = computeDuePeriods('franchise', new Date(Date.UTC(2026, 11, 5)))
    expect(due[0]!.periodStart).toBe('20260901') // bimestre sept-oct
    expect(due[0]!.periodEnd).toBe('20261031')
  })

  it('franchise en base : sept-oct n’est PAS échu au 05/11 (mois+2, pas mois+1 — revue T7)', () => {
    const due = computeDuePeriods('franchise', new Date(Date.UTC(2026, 10, 5)))
    expect(due).not.toContainEqual({
      periodStart: '20260901',
      periodEnd: '20261031',
    })
    // Le plus récent échu au 05/11 est juil-août (échéance 01/10 à 08:00).
    expect(due[0]).toEqual({ periodStart: '20260701', periodEnd: '20260831' })
  })

  it('franchise en base : le bimestre en cours (nov-déc) n’est PAS échu', () => {
    const due = computeDuePeriods('franchise', new Date(Date.UTC(2026, 11, 5)))
    expect(due).not.toContainEqual({
      periodStart: '20261101',
      periodEnd: '20261231',
    })
  })

  // Tableau 13 VERBATIM (revue T7) : simplifié = « le 1er du 2E mois suivant
  // la période » → septembre est échu le 01/11 à 08:00.
  it('simplifié : mensuel (mois civil), échéance mois + 2', () => {
    const due = computeDuePeriods(
      'simplifie',
      new Date(Date.UTC(2026, 10, 1, 9)),
    )
    expect(due[0]).toEqual({ periodStart: '20260901', periodEnd: '20260930' })
  })

  it('simplifié : septembre n’est PAS échu au 01/11 00:00 (avant 08:00) ni octobre (mois+2)', () => {
    const due = computeDuePeriods('simplifie', new Date(Date.UTC(2026, 10, 1)))
    expect(due).not.toContainEqual({
      periodStart: '20260901',
      periodEnd: '20260930',
    })
    expect(due).not.toContainEqual({
      periodStart: '20261001',
      periodEnd: '20261031',
    })
  })

  it('réel normal trimestriel : mensuel à échéance mois + 1 (DISTINCT de simplifié — Tableau 13)', () => {
    expect(CADENCE_BY_REGIME.reel_normal_trimestriel).toEqual({
      kind: 'month',
      deadlineMonthOffset: 1,
    })
    expect(CADENCE_BY_REGIME.simplifie).toEqual({
      kind: 'month',
      deadlineMonthOffset: 2,
    })
    // Au 01/11 09:00, OCTOBRE est échu pour le trimestriel (mois+1)…
    const due = computeDuePeriods(
      'reel_normal_trimestriel',
      new Date(Date.UTC(2026, 10, 1, 9)),
    )
    expect(due[0]).toEqual({ periodStart: '20261001', periodEnd: '20261031' })
    // …alors que pour le simplifié (mois+2) le plus récent échu est septembre.
    const dueSimplifie = computeDuePeriods(
      'simplifie',
      new Date(Date.UTC(2026, 10, 1, 9)),
    )
    expect(dueSimplifie[0]).toEqual({
      periodStart: '20260901',
      periodEnd: '20260930',
    })
  })

  // ── Amendement A2-plan (MUST-FIX) : fenêtre BORNÉE ────────────────────────
  describe('fenêtre bornée (amendement A2-plan)', () => {
    it.each(VAT_REGIMES)(
      'régime %s : jamais plus de MAX_DUE_PERIODS périodes, quelle que soit la date',
      (regime) => {
        const dates = [
          new Date(Date.UTC(2026, 8, 21, 9)),
          new Date(Date.UTC(2030, 0, 1)),
          new Date(Date.UTC(2099, 11, 31, 23, 59)),
        ]
        for (const date of dates) {
          expect(computeDuePeriods(regime, date).length).toBeLessThanOrEqual(
            MAX_DUE_PERIODS,
          )
        }
      },
    )

    it('une date BEAUCOUP plus tardive ne renvoie PAS plus de N périodes (pas de backlog croissant)', () => {
      const due = computeDuePeriods(
        'reel_normal_mensuel',
        new Date(Date.UTC(2099, 11, 31, 23, 59)),
      )
      expect(due.length).toBe(MAX_DUE_PERIODS)
    })

    it('contient bien la période la plus récemment échue (pas un historique arbitraire)', () => {
      const due = computeDuePeriods(
        'reel_normal_mensuel',
        new Date(Date.UTC(2099, 11, 31, 23, 59)),
      )
      // 31/12/2099 23:59 : la décade 1-10/12/2099 est échue (deadline le 21/12 à
      // 08:00) ; la décade 21-31/12 (deadline le 11/01/2100) ne l'est pas
      // encore — la plus récente période échue est donc bien 01-10/12.
      expect(due).toContainEqual({
        periodStart: '20991201',
        periodEnd: '20991210',
      })
    })
  })
})
