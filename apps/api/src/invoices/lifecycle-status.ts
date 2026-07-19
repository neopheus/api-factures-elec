// Cycle de vie CDV de la facture — nomenclature DGFiP (Dossier général v3.2
// §3.6.4, Tableau 8 « Les statuts d'une facture », p. 58-59 ; recoupé avec
// Annexe 2 onglet « Statuts » (col. B/C = obligatoires) et Annexe 7 — règle
// G7.44 = socle obligatoire {200,210,212,213}). Le code numérique est
// l'identifiant réglementaire (champ MDT-105 ram:ProcessConditionCode,
// « 200 à 213 pour les factures pour l'instant » — XP Z12-012 §5.1.1 p. 49).
//
// ★ SWAP AFNOR EFFECTUÉ (2026-07-19). Sources primaires ré-extraites des PDF
// au moment de l'usage (leçon B1) : XP Z12-012 (juillet 2025) et
// XP Z12-014 (juillet 2025). CONSTAT : la norme n'énumère PAS de matrice
// from→to — elle décrit un modèle en deux phases (XP Z12-014 §4.2.1 p. 14) :
//   1. Statuts de TRANSMISSION « Déposée / Rejetée à l'émission, Émise,
//      Reçue / Rejetée en réception, Mise à disposition » qui suivent le
//      cheminement de la facture « dans cet ordre » ; Rejetée est
//      l'ALTERNATIVE exclusive au succès de chaque contrôle (« le statut est
//      soit “Rejetée” en cas d'erreur, soit “Reçue” » — p. 15-16) : aucune
//      Rejetée possible APRÈS Reçue/Mise à disposition ni depuis un statut
//      de traitement.
//   2. Statuts de TRAITEMENT (Refusée, En litige, Suspendue, Complétée,
//      Approuvée, Approuvée Partiellement, Paiement Transmis, Encaissée) qui
//      « peuvent être posés de façon indépendante » (p. 14) : la norme
//      n'impose AUCUN ordre entre eux — d'où le maillage complet ci-dessous.
// Contraintes dures confirmées par la norme :
//   - « tout statut “Rejetée” ou “Refusée” posé sur une facture, ne peut pas
//     être suivi d'un autre statut pour cette facture » (XP Z12-014 §4.3.1
//     p. 22) → refusee/rejetee terminaux, aucune sortie.
//   - Suspendue → Complétée : « En cas de réception d'un statut “Suspendue”,
//     le VENDEUR peut transmettre un statut “Complétée” » (§4.2.1 ét. 4c).
//   - « Paiement Transmis » est « recommandé » donc OPTIONNEL (§4.2.1
//     ét. 5a-5b) → encaissement direct sans 211 autorisé partout.
//   - Encaissée est RÉPÉTABLE : « créer […] un statut “Encaissée” à chaque
//     encaissement partiel ou total » (§4.2.1, obligations des entreprises,
//     p. 18) → self-loop 212→212 (encaissements partiels successifs) et
//     212→211 (paiement du solde) ; Encaissée n'est « terminal » que de
//     FAIT après encaissement total (§4.3.2 ét. 6a-6b), pas de droit.
//     ⇒ RÉVISION A3 ACTÉE : l'interprétation « 212 intégralement terminal »
//     (sur-ensemble du mandat ledger 2.1) est levée — le mandat dur
//     ¬(212→213) reste, lui, garanti (213 ∉ sorties de 212).
// Les 4 corrections mandatées du ledger 2.1 restent satisfaites :
//   ¬(212→213) ; 207→205 ; 208→204 ; 206→205 (toutes couvertes ci-dessous).
//
// HORS PÉRIMÈTRE (statuts normatifs émergents, sans code MDT-105 dans le
// socle « 200 à 213 » — backlog conditionnel, à traiter avec les adaptateurs
// transport réels) : « Annulée » (XP Z12-014 §4.3.3, aucun code assigné),
// « ERREUR_ROUTAGE » (code 221, §4.2.1 p. 16 — signal PDP-R→PDP-E de rejeu,
// pas un statut de facture du socle), « RECEVABLE »/« IRRECEVABLE »
// (codes 500/501 — niveau LOT, pas facture).
//
// PARAMÉTRISATION : le reste du code (LifecycleService,
// InvoicesController, …) n'appelle jamais que `canTransition`/
// `requiresReason` — toute évolution future ne touche QUE cette table,
// `REASON_REQUIRED`, `TERMINAL_STATUSES` et les vecteurs de test (oracle
// indépendant retranscrit à la main dans lifecycle-status.test.ts).

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

// Table ANCRÉE SUR LA NORME (voir bannière : XP Z12-014 §4.2.1 p. 14-18,
// §4.3.1 p. 22 ; XP Z12-012 §5.1.1 p. 49, §5.3 p. 56). Structure :
//   - transmission : uniquement vers l'AVAL de l'ordre normatif (« dans cet
//     ordre »), avec sauts (Émise/Reçue/Mise à disposition sont facultatifs
//     et ne sont pas tous transmis à la contrepartie) ; `rejetee` seulement
//     tant qu'un contrôle de transmission peut encore échouer (jamais après
//     Reçue — alternatives exclusives, p. 15-16).
//   - traitement : maillage complet (« posés de façon indépendante », p. 14)
//     + `encaissee` + `refusee` depuis chacun.
//   - `encaissee` : self-loop (encaissements partiels, p. 18) + retour vers
//     `paiement_transmis` (paiement du solde) — SEUL self-loop de la table.
export const ALLOWED_TRANSITIONS: Record<LifecycleStatus, LifecycleStatus[]> = {
  deposee: [
    'emise',
    'recue',
    'mise_a_disposition',
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
    'rejetee', // rejet en réception encore possible (contrôles PDP-R à venir)
  ],
  emise: [
    'recue',
    'mise_a_disposition',
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
    'rejetee', // rejet en réception (PDP-R) — alternative à Reçue
  ],
  recue: [
    // PLUS de `rejetee` : Reçue = contrôles de réception RÉUSSIS, la norme
    // les pose en alternatives exclusives (XP Z12-014 p. 15-16).
    'mise_a_disposition',
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  mise_a_disposition: [
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  prise_en_charge: [
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  approuvee: [
    'prise_en_charge',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee', // Paiement Transmis optionnel (« recommandé », §4.2.1 ét. 5)
    'refusee',
  ],
  approuvee_partiellement: [
    'prise_en_charge',
    'approuvee', // 206→205 mandaté (ledger 2.1), confirmé par l'indépendance
    'en_litige',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  en_litige: [
    'prise_en_charge',
    'approuvee', // 207→205 mandaté (ledger 2.1) — litige résolu (§4.3.2 ét. 4a)
    'approuvee_partiellement',
    'suspendue',
    'completee',
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  suspendue: [
    'prise_en_charge', // 208→204 mandaté (ledger 2.1)
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'completee', // §4.2.1 ét. 4c : le VENDEUR répond Complétée à Suspendue
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  completee: [
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'paiement_transmis',
    'encaissee',
    'refusee',
  ],
  paiement_transmis: [
    'prise_en_charge',
    'approuvee',
    'approuvee_partiellement',
    'en_litige',
    'suspendue',
    'completee',
    'encaissee',
    'refusee',
  ],
  encaissee: [
    // Encaissements PARTIELS successifs (§4.2.1 p. 18 : « à chaque
    // encaissement partiel ou total ») — seul self-loop autorisé — puis
    // paiement du solde. ¬(212→213) mandaté : `rejetee` absent, comme toute
    // autre sortie non ancrée par la norme.
    'encaissee',
    'paiement_transmis',
  ],
  refusee: [], // terminal (XP Z12-014 §4.3.1 p. 22 — rien ne peut suivre)
  rejetee: [], // terminal (XP Z12-014 §4.3.1 p. 22 — rien ne peut suivre)
}

// Terminaux DE DROIT : Refusée (210) et Rejetée (213) — « ne peut pas être
// suivi d'un autre statut » (XP Z12-014 §4.3.1 p. 22). Encaissée (212) n'est
// PLUS terminale : les encaissements partiels imposent des statuts 212
// successifs (p. 18) ; elle n'est terminale que de fait après encaissement
// total (§4.3.2 ét. 6a-6b).
export const TERMINAL_STATUSES: Set<LifecycleStatus> = new Set<LifecycleStatus>(
  ['refusee', 'rejetee'],
)

// Motifs obligatoires — ancrages :
//   - refusee : « DOIT TOUJOURS être accompagné d'un motif de “Refus” »
//     (XP Z12-014 §4.3.1 p. 21) + G7.25 (Annexe 7 DGFiP).
//   - rejetee : « auquel un motif doit être donné pour expliquer la raison
//     du REJET » (XP Z12-014 §4.2.2 p. 18 et §4.3 p. 20).
//   - en_litige : « un statut “en Litige”, avec un motif, obligatoire »
//     (XP Z12-014 §4.3.2 et §4.3.3, étape 4a).
//   - suspendue : G7.25 (Annexe 7 DGFiP), non infirmé par la norme AFNOR.
const REASON_REQUIRED = new Set<LifecycleStatus>([
  'refusee',
  'rejetee',
  'en_litige',
  'suspendue',
])

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

// Transition valide ⇔ arête déclarée dans ALLOWED_TRANSITIONS[from]. Voir
// bandeau d'en-tête pour l'ancrage normatif (XP Z12-012/-014, extraits
// 2026-07-19) — la table est la traduction machine-à-états du modèle
// « transmission ordonnée / traitement indépendant » de la norme.
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
