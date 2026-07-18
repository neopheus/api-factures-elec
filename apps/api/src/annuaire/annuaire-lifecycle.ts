// Cycle de vie de PUBLICATION annuaire — DISTINCT du CDV facture (200-213) et
// du CDV e-reporting Flux 10 (300/301) (D6, plan 2.4 Task 4). États internes
// PA `draft` (rédigée localement) → `published` (émise au PPF via le port,
// Flux 13) puis acquittement PPF `deposee` ⊕ `rejetee`, plus un chemin
// `masked` atteignable depuis `deposee` (fin d'adressage via Nature='M' —
// une ligne déposée/en vigueur peut être masquée).
//
// CODES RÉGLEMENTAIRES (correctif backlog 3.6 — l'ancienne bannière affirmait
// à tort qu'aucun code officiel n'existait ; extraction primaire du dossier
// général v3.2, §3.5.7 Tableau 6 p.54) : la DGFiP documente DEUX statuts
// obligatoires de ligne d'annuaire — 400 « Acceptée » (contrôlée conforme et
// intégrée) et 401 « Rejetée » (contrôlée non conforme, pas intégrée). Ils
// portent donc leur entier sur `deposee`/`rejetee` ; les états INTERNES PA
// (`draft`/`published`/`masked`) restent `code: null` (leçon 2.3-A3 : ne
// jamais attribuer un faux code réglementaire à un état interne PA).
//
// MOTIFS DE REJET (même correctif) : §3.5.8 Tableau 7 p.55 documente QUATRE
// motifs normatifs (REJ_RG, REJ_HAB, REJ_COH, REJ_VAL_INC). Le champ motif
// de `recordAck` reste aujourd'hui une chaîne libre — le CONTRAINDRE à ces 4
// codes est une DETTE explicite, liée au raccordement des adaptateurs
// annuaire réels (les acquittements réels porteront ces codes ; item
// Xavier) : changer le contrat maintenant, sans source d'acks réelle,
// fabriquerait une validation sur un flux que le port local ne produit pas.
//
// A-DEADLOCK (revue 2.4, .superpowers/sdd/plan-2-4-review.md) : TERMINAL =
// {rejetee, masked} — `deposee` n'est PAS terminal (transition possible vers
// `masked`). Le Task 5 partial index unique de publication libère le slot
// (tenant, maille, dateDebut) dès qu'une ligne atteint rejetee/masked
// (prédicat `WHERE nature='D' AND status NOT IN ('rejetee','masked')`) : il
// n'existe donc AUCUNE transition qui sorte d'un statut terminal ici — une
// re-définition de la même maille×date après rejet/masquage est
// délibérément une NOUVELLE ligne (nouvelle ligne, nouveau statut `draft`),
// jamais une transition depuis l'ancienne ligne terminale, miroir exact du
// précédent RE (rectificatif) 2.3 : le remplacement se fait par une NOUVELLE
// entité, pas par réouverture d'un statut clos.
export const ANNUAIRE_STATUS_META = {
  draft: { code: null, label: 'Rédigée (PA)' },
  published: { code: null, label: 'Publiée au PPF (PA)' },
  // Libellés 400/401 = Tableau 6 p.54 VERBATIM (« Acceptée »/« Rejetée »).
  deposee: { code: 400, label: 'Acceptée (PPF)' },
  rejetee: { code: 401, label: 'Rejetée (PPF)' },
  masked: { code: null, label: 'Masquée' },
} as const satisfies Record<string, { code: number | null; label: string }>

export type AnnuaireLigneStatus = keyof typeof ANNUAIRE_STATUS_META

const ALLOWED: Record<AnnuaireLigneStatus, AnnuaireLigneStatus[]> = {
  draft: ['published'],
  published: ['deposee', 'rejetee'],
  deposee: ['masked'],
  rejetee: [],
  masked: [],
}

// Terminaux au sens de la machine (aucune transition sortante) : rejetee et
// masked. Cf. bandeau A-DEADLOCK ci-dessus — deposee est délibérément exclu.
const TERMINAL = new Set<AnnuaireLigneStatus>(['rejetee', 'masked'])

export function isAnnuaireLigneStatus(v: unknown): v is AnnuaireLigneStatus {
  // Object.hasOwn (et non `v in ANNUAIRE_STATUS_META`) : `in` traverse la
  // chaîne de prototype et reconnaîtrait à tort 'toString'/'constructor'/etc.
  // comme des slugs valides — inacceptable pour un garde de type sur une
  // entrée non fiable (body de requête HTTP / événement externe).
  return typeof v === 'string' && Object.hasOwn(ANNUAIRE_STATUS_META, v)
}

export function isTerminal(s: AnnuaireLigneStatus): boolean {
  return TERMINAL.has(s)
}

export function motifRequired(s: AnnuaireLigneStatus): boolean {
  return s === 'rejetee'
}

export function canTransition(
  from: AnnuaireLigneStatus,
  to: AnnuaireLigneStatus,
): boolean {
  return ALLOWED[from].includes(to)
}

export class InvalidAnnuaireTransitionError extends Error {
  constructor(
    readonly from: AnnuaireLigneStatus,
    readonly to: AnnuaireLigneStatus,
  ) {
    super(`invalid annuaire transition: ${from} → ${to}`)
    this.name = 'InvalidAnnuaireTransitionError'
  }
}

export function assertTransition(
  from: AnnuaireLigneStatus,
  to: AnnuaireLigneStatus,
): void {
  if (!canTransition(from, to))
    throw new InvalidAnnuaireTransitionError(from, to)
}
