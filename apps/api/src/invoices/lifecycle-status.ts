// Cycle de vie CDV de la facture — nomenclature DGFiP (Dossier général v3.2
// §3.6.4, Tableau 8 « Les statuts d'une facture », p. 58-59 ; recoupé avec
// Annexe 2 onglet « Statuts » (col. B/C = obligatoires) et Annexe 7 — règle
// G7.44 = socle obligatoire {200,210,212,213}). Le code numérique est
// l'identifiant réglementaire (champ MDT-105 ram:ProcessConditionCode,
// CODE(3) libre — aucune énumération XSD ne le contraint).
//
// ⚠ Transitions : aucune matrice de transitions autorisées n'est énumérée
// par la DGFiP dans le dépôt (Figures 48/49 non extractibles, circuit de
// transmission purement graphique). La machine ci-dessous encode donc une
// **interprétation projet** — chronologie monotone documentée (code
// strictement croissant, statuts facultatifs sautables, terminaux 210/213
// sans sortie) — à durcir contre la norme AFNOR XP Z12-012 (hors dépôt)
// avant mise en production. On n'invente pas de règle DGFiP non écrite ; on
// applique la seule contrainte documentée (« respect de la chronologie » +
// G7.19/G7.25/G7.45).
//
// A7 (amendement contrôleur, binding) : ce modèle monotone autorise
// explicitement 212 (Encaissée) → 213 (Rejetée) — une facture encaissée
// peut être ultérieurement rejetée (anomalie détectée après paiement).
// C'est un cas inhabituel qu'AFNOR XP Z12-012 pourrait interdire ; il reste
// autorisé ici par simple application de la règle monotone (212 n'est pas
// un statut terminal, 213 > 212) et doit être réexaminé lors du futur
// durcissement contre cette norme.

export const STATUS_META = {
  deposee: { code: 200, label: 'Déposée', mandatory: true },
  emise: { code: 201, label: 'Emise par la plateforme', mandatory: false },
  recue: { code: 202, label: 'Reçue par la plateforme', mandatory: false },
  mise_a_disposition: {
    code: 203,
    label: 'Mise à disposition',
    mandatory: false,
  },
  prise_en_charge: { code: 204, label: 'Prise en charge', mandatory: false },
  approuvee: { code: 205, label: 'Approuvée', mandatory: false },
  approuvee_partiellement: {
    code: 206,
    label: 'Approuvée partiellement',
    mandatory: false,
  },
  en_litige: { code: 207, label: 'En litige', mandatory: false },
  suspendue: { code: 208, label: 'Suspendue', mandatory: false },
  completee: { code: 209, label: 'Complétée', mandatory: false },
  refusee: { code: 210, label: 'Refusée', mandatory: true },
  paiement_transmis: {
    code: 211,
    label: 'Paiement transmis',
    mandatory: false,
  },
  encaissee: { code: 212, label: 'Encaissée', mandatory: true },
  rejetee: { code: 213, label: 'Rejetée', mandatory: true },
} as const

export type LifecycleStatus = keyof typeof STATUS_META

export const LIFECYCLE_STATUSES = Object.keys(STATUS_META) as LifecycleStatus[]

export const INITIAL_STATUS: LifecycleStatus = 'deposee'

// 210 Refusée & 213 Rejetée : statuts terminaux d'exception (Tableau 8 :
// mènent à une annulation comptable / avoir interne) — aucune transition
// sortante, y compris entre eux (cf. tests : refusee ↔ rejetee interdits
// malgré 210 < 213).
export const TERMINAL_STATUSES: Set<LifecycleStatus> = new Set<LifecycleStatus>(
  ['refusee', 'rejetee'],
)

// G7.25 : un passage en Refusée (210) ou Suspendue (208) exige un motif
// (commentaire MDT-126).
const REASON_REQUIRED = new Set<LifecycleStatus>(['refusee', 'suspendue'])

export function isLifecycleStatus(v: unknown): v is LifecycleStatus {
  return typeof v === 'string' && v in STATUS_META
}

export function isTerminal(s: LifecycleStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

export function requiresReason(s: LifecycleStatus): boolean {
  return REASON_REQUIRED.has(s)
}

export function statusByCode(code: number): LifecycleStatus | null {
  return (
    (LIFECYCLE_STATUSES.find((s) => STATUS_META[s].code === code) as
      | LifecycleStatus
      | undefined) ?? null
  )
}

// Chronologie monotone : transition valide ⇔ from non terminal ET
// code(to) > code(from). Voir bandeau d'en-tête pour le statut
// d'interprétation projet et le cas particulier A7 (212 → 213).
export function canTransition(
  from: LifecycleStatus,
  to: LifecycleStatus,
): boolean {
  if (isTerminal(from)) return false
  return STATUS_META[to].code > STATUS_META[from].code
}

export class InvalidLifecycleTransitionError extends Error {
  constructor(
    readonly from: LifecycleStatus,
    readonly to: LifecycleStatus,
  ) {
    super(`invalid lifecycle transition: ${from} → ${to}`)
    this.name = 'InvalidLifecycleTransitionError'
  }
}

export function assertTransition(
  from: LifecycleStatus,
  to: LifecycleStatus,
): void {
  if (!canTransition(from, to))
    throw new InvalidLifecycleTransitionError(from, to)
}
