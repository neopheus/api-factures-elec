// Cycle de vie e-reporting Flux 10 — DISTINCT du CDV facture (D5, spec §3.7.9).
// Statuts officiels PPF : 300 Déposée (Tableau 5) / 301 Rejetée (+ motif REJ_*,
// Tableau 6, §3.7.10). `prepared`/`transmitted` = états internes PA avant
// acquittement. Figure 59 (visuel) non extractible → modèle binaire fondé sur
// le TEXTE §3.7.9, marqué INTERPRÉTATION PROJET.
//
// A3 (amendement contrôleur, binding) : `prepared`/`transmitted` sont des
// états INTERNES à la plateforme d'agrégation (PA), antérieurs à toute
// transmission au PPF — ils n'ont PAS de code DGFiP. Le plan initial leur
// attribuait `code: 0`/`code: 1`, ce qui laisserait croire à un code
// réglementaire inventé (risque de fuite dans un export/endpoint comme s'il
// s'agissait d'un code Tableau 5). On utilise donc `code: null` pour ces deux
// états ; seuls `deposee` (300) et `rejetee` (301) portent un code DGFiP réel.
export const EREPORTING_STATUS_META = {
  prepared: { code: null, label: 'Préparée (PA)' },
  transmitted: { code: null, label: 'Transmise au PPF (PA)' },
  deposee: { code: 300, label: 'Déposée' },
  rejetee: { code: 301, label: 'Rejetée' },
} as const satisfies Record<string, { code: number | null; label: string }>

export type EreportingStatus = keyof typeof EREPORTING_STATUS_META

const ALLOWED: Record<EreportingStatus, EreportingStatus[]> = {
  prepared: ['transmitted'],
  transmitted: ['deposee', 'rejetee'],
  deposee: [],
  rejetee: [],
}

const TERMINAL = new Set<EreportingStatus>(['deposee', 'rejetee'])

export function isEreportingStatus(v: unknown): v is EreportingStatus {
  // Object.hasOwn (et non `v in EREPORTING_STATUS_META`) : `in` traverse la
  // chaîne de prototype et reconnaîtrait à tort 'toString'/'constructor'/etc.
  // comme des slugs valides — inacceptable pour un garde de type sur une
  // entrée non fiable (Tasks 5+ : body de requête HTTP / événement externe).
  return typeof v === 'string' && Object.hasOwn(EREPORTING_STATUS_META, v)
}

export function isTerminal(s: EreportingStatus): boolean {
  return TERMINAL.has(s)
}

export function motifRequired(s: EreportingStatus): boolean {
  return s === 'rejetee'
}

export function canTransition(
  from: EreportingStatus,
  to: EreportingStatus,
): boolean {
  return ALLOWED[from].includes(to)
}

export class InvalidEreportingTransitionError extends Error {
  constructor(
    readonly from: EreportingStatus,
    readonly to: EreportingStatus,
  ) {
    super(`invalid e-reporting transition: ${from} → ${to}`)
    this.name = 'InvalidEreportingTransitionError'
  }
}

export function assertTransition(
  from: EreportingStatus,
  to: EreportingStatus,
): void {
  if (!canTransition(from, to))
    throw new InvalidEreportingTransitionError(from, to)
}

export type { RejectMotif } from './nomenclature.js'
