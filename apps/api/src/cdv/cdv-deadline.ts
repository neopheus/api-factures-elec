// Fenêtre bornée + échéance 24h (§3.6.6) de l'ordonnanceur CDV (Task 7,
// amendement A5, plan-3-1-review.md) — fonctions PURES : `now`/`lookbackMs`/
// `statusCreatedAt` sont TOUJOURS des paramètres injectés par l'appelant,
// JAMAIS lus depuis l'horloge système ici (motif `computeDuePeriods`,
// ereporting/period.ts — 100 % testable sur vecteurs de dates fixes).

// Borne INFÉRIEURE de la fenêtre de rattrapage du sweep (D8, 1ère couche de
// la défense en profondeur anti-double-envoi — cf. worker/cdv-transmission-
// sweep.service.ts pour les couches 2/3) — passée en `p_since` à
// `find_cdv_transmissions_due` (Task 4/migration 0022) : le sweep ne relit
// JAMAIS tout le journal scellé `invoice_status_events`, quelle que soit
// l'ancienneté du dernier passage réussi. `CDV_TRANSMISSION_LOOKBACK_MS`
// (défaut 48h = 2× le SLA 24h, D8) est le `lookbackMs` fourni par l'appelant.
export function dueSince(now: Date, lookbackMs: number): Date {
  return new Date(now.getTime() - lookbackMs)
}

const DEADLINE_MS = 24 * 60 * 60 * 1000

// Échéance réglementaire 24h (§3.6.6) : un statut CDV FACTURE obligatoire,
// scellé à `statusCreatedAt` (invoice_status_events.created_at, journal 2.2),
// doit être transmis au PPF sous 24h. Ce drapeau est PUREMENT OBSERVATIONNEL
// (journalisation d'un dépassement de SLA, amendement A6 du plan — fuseau
// UTC vs Paris = interprétation projet) : AUCUN comportement de rejet ou de
// blocage n'en dépend — le sweep borné (fenêtre `dueSince` ci-dessus) et le
// stuck-retry (batch borné, cdv-stuck-retry.service.ts) restent les SEULS
// mécanismes qui déterminent si une transmission est retentée. « Pile » à
// l'échéance (exactement +24h) compte comme DÉJÀ dépassée (limite atteinte).
export function isPastDeadline(statusCreatedAt: Date, now: Date): boolean {
  return now.getTime() - statusCreatedAt.getTime() >= DEADLINE_MS
}
