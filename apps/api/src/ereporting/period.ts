import type { VatRegime } from './nomenclature.js'

// ────────────────────────────────────────────────────────────────────────
// Cadence de transmission par régime TVA (D4/D11, mapping data-driven
// ci-dessous), alignée sur le Tableau 13 PRIMAIRE (§3.7.7, spec externes
// v3.2 p.68, extraction -layout cellule par cellule — la transcription du
// dossier research-2-3-questions.md comportait des DÉSALIGNEMENTS de
// colonnes, corrigés par la revue du plan 3.2 puis vérifiés contre le PDF
// par le contrôleur). Colonne opérationnelle = « Date et heure limites de
// transmission à l'administration fiscale par la plateforme agréée »
// (8h00). MOTIF CONSTANT du tableau : échéance PA = échéance de dépôt du
// DÉCLARANT + 1 jour (transmettre avant l'échéance du déclarant émettrait
// des données INCOMPLÈTES).
//   - reel_normal_mensuel      : décadaire (01-10 / 11-20 / 21-fin) ;
//     échéances « le 21 du mois / le 1er du mois suivant / le 11 du mois
//     suivant, à 8h00 ».
//   - reel_normal_trimestriel  : mensuelle (mois civil) ; échéance « le 11
//     du mois suivant la période, à 8h00 » (HOTFIX post-3.1 : le code
//     shippé en 2.3 disait « le 1er » d'après la transcription fausse — le
//     déclarant a jusqu'au 10 pour déposer, transmettre le 1er aurait été
//     INCOMPLET).
//   - simplifie                : mensuelle (mois civil) ; échéance « le 1er
//     du 2E mois suivant la période, à 8h00 » (revue T7 : mois+2, PAS mois+1).
//   - franchise                : bimestrielle (bimestres civils : jan-fév,
//     mar-avr, mai-juin, juil-août, sept-oct, nov-déc) ; échéance « le 1er
//     du 2E mois suivant la période, à 8h00 » = fin de bimestre + 2 mois.
//
// INTERPRÉTATION PROJET RÉSIDUELLE (à confirmer go-live) : les « 8h00 » du
// Tableau 13 sont modélisées à 08:00 UTC (≈ 09:00/10:00 heure de Paris) —
// la période devient due APRÈS l'échéance réelle Paris, côté SÛR (toutes
// les données du déclarant sont arrivées), et reste largement dans la
// fenêtre de remise PPF de 8h (§3.7.7).
// ────────────────────────────────────────────────────────────────────────

export type DuePeriod = {
  periodStart: string // AAAAMMJJ
  periodEnd: string // AAAAMMJJ
}

export type PeriodCadence =
  | { kind: 'decade' }
  // deadlineMonthOffset : mois de l'échéance (M+1 trimestriel, M+2 simplifié) ;
  // deadlineDay : JOUR de l'échéance dans ce mois — 11 pour le trimestriel
  // (« le 11 du mois suivant », Tableau 13 primaire p.68), 1 pour le
  // simplifié (« le 1er du 2e mois suivant »).
  | { kind: 'month'; deadlineMonthOffset: 1 | 2; deadlineDay: 1 | 11 }
  | { kind: 'bimester' }

// D4, data-driven : AUCUNE branche de type switch/if sur le RÉGIME dans la
// logique de calcul — seule cette table associe un régime à sa cadence (et
// à son échéance mois+jour, revue T7 + hotfix Tableau 13 primaire).
export const CADENCE_BY_REGIME: Record<VatRegime, PeriodCadence> = {
  reel_normal_mensuel: { kind: 'decade' },
  reel_normal_trimestriel: {
    kind: 'month',
    deadlineMonthOffset: 1,
    deadlineDay: 11,
  },
  simplifie: { kind: 'month', deadlineMonthOffset: 2, deadlineDay: 1 },
  franchise: { kind: 'bimester' },
}

// Amendement A2-plan (MUST-FIX, revue du plan) — fenêtre BORNÉE : au plus
// les N périodes les plus récemment échues (la période tout juste échue +
// une de rattrapage), JAMAIS un backlog croissant depuis l'origine des
// temps. Un rattrapage plus long que N est un PROCESSUS D'EXPLOITATION
// (ré-émission manuelle/ciblée), PAS la responsabilité du balayage horaire
// automatique — sinon celui-ci ré-enfilerait un historique entier à chaque
// tour et grossirait sans limite. C'est la couche 1 de la défense en
// profondeur anti double-envoi (cf. worker/ereporting-sweep.service.ts pour
// les couches 2 et 3).
export const MAX_DUE_PERIODS = 2

interface CandidatePeriod extends DuePeriod {
  deadline: Date
}

// Arithmétique de mois SANS Date.now() ni dépendance au fuseau local :
// `total` reste positif pour toute année calendaire réaliste, mais la
// double correction modulo protège aussi les valeurs limites.
function addMonths(
  year: number,
  month0: number,
  delta: number,
): { y: number; m0: number } {
  const total = year * 12 + month0 + delta
  const y = Math.floor(total / 12)
  const m0 = ((total % 12) + 12) % 12
  return { y, m0 }
}

// Jour 0 du mois SUIVANT = dernier jour du mois `month0` (UTC, sans
// ambiguïté de fuseau — cohérent avec le reste du module).
function daysInMonthOf(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

function fmt(year: number, month0: number, day: number): string {
  return `${year}${String(month0 + 1).padStart(2, '0')}${String(day).padStart(2, '0')}`
}

// Décades du régime réel normal mensuel (D4) : 01-10 (échéance le 21 du
// MÊME mois à 08:00 UTC), 11-20 (échéance le 1er du mois SUIVANT à 08:00
// UTC), 21-fin (échéance le 11 du mois suivant à 08:00 UTC). Fenêtre de
// génération : 4 mois en arrière — largement suffisant pour couvrir
// MAX_DUE_PERIODS décades quelle que soit `referenceDate` (cf. tests
// « fenêtre bornée »).
function decadeCandidates(
  refYear: number,
  refMonth0: number,
): CandidatePeriod[] {
  const out: CandidatePeriod[] = []
  for (let offset = -3; offset <= 0; offset++) {
    const { y, m0 } = addMonths(refYear, refMonth0, offset)
    const next = addMonths(y, m0, 1)
    const lastDay = daysInMonthOf(y, m0)
    out.push({
      periodStart: fmt(y, m0, 1),
      periodEnd: fmt(y, m0, 10),
      deadline: new Date(Date.UTC(y, m0, 21, 8)),
    })
    out.push({
      periodStart: fmt(y, m0, 11),
      periodEnd: fmt(y, m0, 20),
      deadline: new Date(Date.UTC(next.y, next.m0, 1, 8)),
    })
    out.push({
      periodStart: fmt(y, m0, 21),
      periodEnd: fmt(y, m0, lastDay),
      deadline: new Date(Date.UTC(next.y, next.m0, 11, 8)),
    })
  }
  return out
}

// Mois civil (simplifié : 1er de M+2 ; réel normal trimestriel : 11 de M+1
// — Tableau 13 PRIMAIRE p.68, hotfix post-3.1) : échéance le jour
// `deadlineDay` du mois M + `deadlineMonthOffset`, à 08:00 UTC. Fenêtre :
// 6 mois en arrière (couvre MAX_DUE_PERIODS quel que soit l'offset).
function monthCandidates(
  refYear: number,
  refMonth0: number,
  deadlineMonthOffset: number,
  deadlineDay: number,
): CandidatePeriod[] {
  const out: CandidatePeriod[] = []
  for (let offset = -5; offset <= 0; offset++) {
    const { y, m0 } = addMonths(refYear, refMonth0, offset)
    const due = addMonths(y, m0, deadlineMonthOffset)
    out.push({
      periodStart: fmt(y, m0, 1),
      periodEnd: fmt(y, m0, daysInMonthOf(y, m0)),
      deadline: new Date(Date.UTC(due.y, due.m0, deadlineDay, 8)),
    })
  }
  return out
}

// Bimestres civils (franchise en base — D4) : jan-fév, mar-avr, mai-juin,
// juil-août, sept-oct, nov-déc. Échéance « le 1er du 2E mois suivant la
// période » (Tableau 13 verbatim, revue T7) = début de bimestre + 3 mois
// (fin + 2), à 08:00 UTC. Fenêtre : 5 bimestres (10 mois) en arrière.
function bimesterCandidates(
  refYear: number,
  refMonth0: number,
): CandidatePeriod[] {
  const out: CandidatePeriod[] = []
  const startMonth0 = refMonth0 - (refMonth0 % 2)
  for (let k = 0; k <= 4; k++) {
    const { y, m0 } = addMonths(refYear, startMonth0, -2 * k)
    const endMonth = addMonths(y, m0, 1)
    const deadlineMonth = addMonths(y, m0, 3)
    out.push({
      periodStart: fmt(y, m0, 1),
      periodEnd: fmt(
        endMonth.y,
        endMonth.m0,
        daysInMonthOf(endMonth.y, endMonth.m0),
      ),
      deadline: new Date(Date.UTC(deadlineMonth.y, deadlineMonth.m0, 1, 8)),
    })
  }
  return out
}

// Registre horloge (amendement plan A6) : `referenceDate` est un PARAMÈTRE —
// AUCUN `Date.now()` dans cette logique. Le sweep
// (worker/ereporting-sweep.service.ts) passe `new Date()`. Fonction PURE,
// 100 % couverte, testable sur dates fixes.
//
// Renvoie AU PLUS `MAX_DUE_PERIODS` périodes — les plus récemment échues à
// `referenceDate` (triées par échéance décroissante), amendement A2-plan.
export function computeDuePeriods(
  regime: VatRegime,
  referenceDate: Date,
): DuePeriod[] {
  const cadence = CADENCE_BY_REGIME[regime]
  const refYear = referenceDate.getUTCFullYear()
  const refMonth0 = referenceDate.getUTCMonth()
  const candidates =
    cadence.kind === 'decade'
      ? decadeCandidates(refYear, refMonth0)
      : cadence.kind === 'month'
        ? monthCandidates(
            refYear,
            refMonth0,
            cadence.deadlineMonthOffset,
            cadence.deadlineDay,
          )
        : bimesterCandidates(refYear, refMonth0)
  const refTime = referenceDate.getTime()
  return candidates
    .filter((c) => c.deadline.getTime() <= refTime)
    .sort((a, b) => b.deadline.getTime() - a.deadline.getTime())
    .slice(0, MAX_DUE_PERIODS)
    .map(({ periodStart, periodEnd }) => ({ periodStart, periodEnd }))
}
