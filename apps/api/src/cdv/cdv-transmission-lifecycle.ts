// Cycle de vie de LIVRAISON d'un CDV (Flux 6 / CDAR) — DISTINCT du CDV
// facture (200-213, `invoices/lifecycle-status.ts`), du CDV e-reporting Flux
// 10 (300/301, `ereporting/ereporting-lifecycle.ts`) et du cycle de
// publication annuaire (`annuaire/annuaire-lifecycle.ts`) — D4, plan 3.1
// Task 3. Ce module suit la TRANSMISSION du message de statut (déjà généré
// par `flux6-cdar.ts`, Task 2) vers ses cibles (PPF + plateforme de
// réception), PAS le statut de la facture elle-même.
//
// Cycle : `prepared` (F6 rédigé localement, écrit write-once par le port,
// Task 5) → `transmitted` (émis via `CdvTransmissionPort`) → acquittement
// `acknowledged` ⊕ `rejected` ; plus un chemin `parked` (destinataire non
// adressable/ambigu — `RecipientUnaddressableError`/`AmbiguousResolutionError`
// de l'annuaire 2.4, D6) qui n'est PAS terminal : il est repris par le sweep
// `parked`→retry dès que l'annuaire est mis à jour (T7, miroir archive-retry
// 2.2 / stuck-draft annuaire 2.4).
//
// `code` (D4) : `rejected` porte le SEUL code F6 réellement documenté —
// **601 « message CDV rejeté »** (Annexe 2 onglet « Statuts », objet
// « message CDV (Flux 6) ») — DGFiP réel, pas une invention projet.
// `prepared`/`transmitted`/`parked`/`acknowledged` = `code: null` : ce sont
// des états INTERNES à la plateforme (leçon 2.3-A3 : jamais de code
// réglementaire inventé pour un état qui n'en a pas). En particulier,
// `acknowledged` représente une acceptation **IMPLICITE** — l'Annexe 2 ne
// fournit AUCUN code F6 d'acceptation explicite, seul le rejet (601) est
// codifié ; l'absence de rejet dans le délai vaut donc acceptation
// (interprétation projet documentée, cf. plan D4/D7).
//
// Désambiguïsation genèse vs transmission (D4, miroir 2.3-T9, exercée par
// Tasks 4/6/8, HORS PÉRIMÈTRE de ce module pur) : un rejet LOCAL pré-envoi
// (F6 structurellement invalide, `validateFlux6Structure` Task 2) naît
// `rejected` par GENÈSE (jamais via `assertTransition`, donc hors de la
// table ci-dessous) ; un rejet PPF/réseau porteur du code 601 EST, lui, la
// transition `transmitted → rejected` déclarée ici.
//
// Miroir structurel de `ereporting-lifecycle.ts` (transitions `ALLOWED`,
// `Object.hasOwn`, discipline motif/erreur typée) — SÉPARÉ, sans conflation
// (3ᵉ instance de ce patron après e-reporting 2.3 et annuaire 2.4).
export const CDV_TRANSMISSION_STATUS_META = {
  prepared: { code: null, label: 'Préparée (F6 rédigé, PA)' },
  transmitted: { code: null, label: 'Transmise (port)' },
  parked: {
    code: null,
    label: 'En attente de reprise (destinataire non adressable)',
  },
  acknowledged: { code: null, label: 'Acquittée (acceptation implicite)' },
  rejected: { code: 601, label: 'Message CDV rejeté' },
} as const satisfies Record<string, { code: number | null; label: string }>

export type CdvTransmissionStatus = keyof typeof CDV_TRANSMISSION_STATUS_META

// Table PARAMÉTRÉE (D4) : `parked` est repris vers `transmitted` (reprise,
// T7) ou abandonné vers `rejected` (sweep épuisé) ; `acknowledged`/`rejected`
// sont terminaux (aucune arête sortante).
const ALLOWED: Record<CdvTransmissionStatus, CdvTransmissionStatus[]> = {
  prepared: ['transmitted', 'parked', 'rejected'],
  transmitted: ['acknowledged', 'rejected'],
  parked: ['transmitted', 'rejected'],
  acknowledged: [],
  rejected: [],
}

// Terminaux : `acknowledged` et `rejected` uniquement. `parked` est
// délibérément EXCLU (cf. bannière ci-dessus) — c'est un état d'attente
// retryable, pas une fin de vie.
const TERMINAL = new Set<CdvTransmissionStatus>(['acknowledged', 'rejected'])

export function isCdvTransmissionStatus(
  v: unknown,
): v is CdvTransmissionStatus {
  // Object.hasOwn (et non `v in CDV_TRANSMISSION_STATUS_META`) : `in`
  // traverse la chaîne de prototype et reconnaîtrait à tort
  // 'toString'/'constructor'/etc. comme des slugs valides — inacceptable
  // pour un garde de type sur une entrée non fiable (Task 8 : body de
  // requête HTTP `recordPpfStatus`/`recordRecipientStatus`).
  return typeof v === 'string' && Object.hasOwn(CDV_TRANSMISSION_STATUS_META, v)
}

export function isTerminal(s: CdvTransmissionStatus): boolean {
  return TERMINAL.has(s)
}

export function motifRequired(s: CdvTransmissionStatus): boolean {
  return s === 'rejected'
}

export function canTransition(
  from: CdvTransmissionStatus,
  to: CdvTransmissionStatus,
): boolean {
  // Object.hasOwn en garde d'entrée (même raison que isCdvTransmissionStatus
  // ci-dessus) : un appelant qui contourne le typage statique ne doit jamais
  // résoudre une méthode héritée d'Object.prototype sur `ALLOWED`.
  if (!Object.hasOwn(ALLOWED, from)) return false
  return ALLOWED[from].includes(to)
}

export class InvalidCdvTransmissionTransitionError extends Error {
  constructor(
    readonly from: CdvTransmissionStatus,
    readonly to: CdvTransmissionStatus,
  ) {
    super(`invalid cdv transmission transition: ${from} → ${to}`)
    this.name = 'InvalidCdvTransmissionTransitionError'
  }
}

export function assertTransition(
  from: CdvTransmissionStatus,
  to: CdvTransmissionStatus,
): void {
  if (!canTransition(from, to))
    throw new InvalidCdvTransmissionTransitionError(from, to)
}
