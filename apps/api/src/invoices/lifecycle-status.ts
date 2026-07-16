// Cycle de vie CDV de la facture — nomenclature DGFiP (Dossier général v3.2
// §3.6.4, Tableau 8 « Les statuts d'une facture », p. 58-59 ; recoupé avec
// Annexe 2 onglet « Statuts » (col. B/C = obligatoires) et Annexe 7 — règle
// G7.44 = socle obligatoire {200,210,212,213}). Le code numérique est
// l'identifiant réglementaire (champ MDT-105 ram:ProcessConditionCode,
// CODE(3) libre — aucune énumération XSD ne le contraint).
//
// ⚠ MATRICE DAG — INTERPRÉTATION PROJET, pas une norme DGFiP publiée.
// Aucune matrice de transitions n'est énumérée par la DGFiP dans le dépôt
// (Figures 48/49 non extractibles, circuit de transmission purement
// graphique). La norme qui énumère ces transitions — AFNOR XP Z12-012 —
// est PAYANTE et hors dépôt (item Xavier) : la table ci-dessous est donc un
// backbone chronologique documenté (§3.6.4 Tableau 8, respect de la
// chronologie + G7.19/G7.25/G7.45) complété par PARAMÉTRISATION dans
// `ALLOWED_TRANSITIONS` (Record from → to[]). PARAMÉTRISATION : le reste du
// code (LifecycleService, InvoicesController, …) n'appelle jamais que
// `canTransition`/`requiresReason` — un swap contre AFNOR XP Z12-012 ne
// touchera QUE cette table + `REASON_REQUIRED` + les vecteurs de test.
//
// REMPLACE le monotone (BLOQUEUR go-live, ledger 2.1 — 4 anomalies
// nommées) : le modèle « code strictement croissant » précédent violait 4
// règles métier mandatées. Corrections mandatées, appliquées ici :
//   - INTERDIRE 212 (Encaissée) → 213 (Rejetée) : chemin heureux clos.
//   - AUTORISER 207 (En litige) → 205 (Approuvée) : dispute résolue.
//   - AUTORISER 208 (Suspendue) → 204 (Prise en charge) : reprise post-susp.
//   - AUTORISER 206 (Approuvée partiellement) → 205 (Approuvée) : complétion.
//
// ⚠️ A3 (amendement contrôleur, binding, plan-3-1-review.md) : le mandat DUR
// exige SEULEMENT ¬(212→213). Rendre 212 ENTIÈREMENT terminal (interdire
// aussi 212→205/207/211/…) est un SUR-ENSEMBLE du mandat — une
// interprétation projet plus stricte, PAS une exigence des 4 corrections
// ci-dessus. Défendable (paiement CGI 290 A ; aucune source publique
// n'ancre de transition sortante de 212 : un « paiement partiel » n'est pas
// un statut distinct, un litige post-paiement ne pèse que sur des factures
// pré-paiement (207), un remboursement est un nouvel avoir donc une
// nouvelle facture) — mais RÉVISABLE à l'acquisition d'AFNOR XP Z12-012.
// Les retours restaurés (207→205, 208→204, 206→205) sont eux aussi de la
// business-logic + mandat ledger, non normés AFNOR.

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

// Table PROPOSÉE (INTERPRÉTATION PROJET — voir bannière ci-dessus). Backbone
// = chronologie documentée §3.6.4 + les 4 CORRECTIONS mandatées (ledger
// 2.1). Acquérir AFNOR XP Z12-012 ne change QUE cette table + REASON_REQUIRED
// + les vecteurs de test (paramétrisation confirmée par sweep des
// consommateurs — LifecycleService n'appelle que canTransition/requiresReason).
export const ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  deposee: [
    'emise',
    'recue',
    'mise_a_disposition',
    'prise_en_charge',
    'refusee',
    'rejetee',
  ],
  emise: [
    'recue',
    'mise_a_disposition',
    'prise_en_charge',
    'refusee',
    'rejetee',
  ],
  recue: ['mise_a_disposition', 'prise_en_charge', 'refusee', 'rejetee'],
  mise_a_disposition: ['prise_en_charge', 'refusee', 'rejetee'],
  prise_en_charge: [
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'refusee',
    'rejetee',
  ],
  approuvee: ['completee', 'paiement_transmis', 'en_litige', 'refusee'],
  approuvee_partiellement: [
    'approuvee',
    'en_litige',
    'suspendue',
    'completee',
    'refusee',
    'rejetee',
  ], // 206→205 (correction mandatée, ledger 2.1)
  en_litige: [
    'approuvee',
    'approuvee_partiellement',
    'prise_en_charge',
    'suspendue',
    'refusee',
  ], // 207→205 (correction mandatée, ledger 2.1)
  suspendue: [
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'refusee',
  ], // 208→204 (correction mandatée, ledger 2.1)
  completee: ['paiement_transmis', 'encaissee', 'refusee'],
  paiement_transmis: ['encaissee'],
  refusee: [], // terminal (avoir interne)
  encaissee: [], // terminal (CGI 290 A) → 212→213 INTERDIT (correction mandatée) ; cf. A3 : stricte-que-le-mandat
  rejetee: [], // terminal (anomalie fonctionnelle)
}

// Terminaux : Refusée (210), Encaissée (212) et Rejetée (213) — aucune
// transition sortante, y compris entre eux. Encaissée-terminal est une
// interprétation STRICTE-QUE-LE-MANDAT (cf. bandeau A3 ci-dessus) : le
// mandat dur n'exige que ¬(212→213), pas la fermeture totale de 212.
export const TERMINAL_STATUSES: Set<LifecycleStatus> = new Set<LifecycleStatus>(
  ['refusee', 'encaissee', 'rejetee'],
)

// G7.25 : un passage en Refusée (210) ou Suspendue (208) exige un motif
// (commentaire MDT-126).
const REASON_REQUIRED = new Set<LifecycleStatus>(['refusee', 'suspendue'])

export function isLifecycleStatus(v: unknown): v is LifecycleStatus {
  // Object.hasOwn (et non `v in STATUS_META`) : `in` traverse la chaîne de
  // prototype et reconnaîtrait à tort 'toString'/'constructor'/etc. comme
  // des slugs valides — inacceptable pour un garde de type sur une entrée
  // non fiable (Tasks 5/6 : body de requête HTTP).
  return typeof v === 'string' && Object.hasOwn(STATUS_META, v)
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

// Matrice DAG paramétrée : transition valide ⇔ arête déclarée dans
// ALLOWED_TRANSITIONS[from]. Voir bandeau d'en-tête pour le statut
// d'interprétation projet (AFNOR XP Z12-012) et l'amendement A3 (212-terminal
// stricte-que-le-mandat).
//
// Object.hasOwn (et non un accès direct `ALLOWED_TRANSITIONS[from]`) : `from`
// n'est fiable qu'au typage statique — un appelant qui contourne le type
// (entrée HTTP non validée en amont, cf. tests) peut passer 'toString' etc.
// Sans ce garde, `ALLOWED_TRANSITIONS['toString']` résout la méthode héritée
// d'Object.prototype (une fonction, pas un tableau) et `.includes(to)` lève
// un TypeError au lieu de refuser proprement la transition — même défense
// que isLifecycleStatus ci-dessus, appliquée ici pour la même raison.
export function canTransition(
  from: LifecycleStatus,
  to: LifecycleStatus,
): boolean {
  if (!Object.hasOwn(ALLOWED_TRANSITIONS, from)) return false
  return ALLOWED_TRANSITIONS[from].includes(to)
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
