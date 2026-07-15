import { createHash } from 'node:crypto'

// Événement de statut réduit aux champs SCELLÉS (miroir de seal_status_event,
// migration 0012). createdAtMs = created_at tronqué à la milliseconde (getTime()).
//
// CONTRAT D'ENTRÉE — les consommateurs (vérification Task 4, PAF Task 6, bundle
// WORM Task 7) doivent le GARANTIR en reconstruisant l'événement depuis une ligne
// DB, sinon le hash recalculé diverge du sceau et une fausse altération est
// signalée :
//  • tenantId / invoiceId : uuid en MINUSCULES, hyphénés 8-4-4-4-12 (comme PG ::text) ;
//  • seq / createdAtMs : entiers sûrs (< 2^53), sérialisés en décimal par String() ;
//  • fromStatus / reason : `null` pour l'absence (le SQL rend NULL ; ne PAS passer
//    `undefined` — toléré défensivement par field() mais hors contrat) ;
//  • createdAtMs : millisecondes UTC (Date.getTime()) de la valeur DÉJÀ tronquée à
//    la ms par le trigger (date_trunc('milliseconds', …)).
export interface StatusEventForHash {
  tenantId: string
  invoiceId: string
  seq: number
  fromStatus: string | null
  toStatus: string
  actor: string
  reason: string | null
  createdAtMs: number
}

// Encodage d'un champ, longueur-préfixé (injection-proof) : NULL → '-1|', sinon
// octet_length(UTF-8)||'|'||valeur. Identique à ledger_field(text) côté base.
// `undefined` est assimilé à `null` (robustesse au bord de désérialisation : un
// consommateur reconstruisant un événement depuis une ligne DB pourrait obtenir
// `undefined` pour un champ absent — on évite ainsi un TypeError opaque de
// Buffer.byteLength ; `undefined` et `null` scellent identiquement '-1|').
function field(v: string | null | undefined): string {
  if (v === null || v === undefined) return '-1|'
  return `${Buffer.byteLength(v, 'utf8')}|${v}`
}

// Ordre FIGÉ — doit rester synchronisé avec seal_status_event (migration 0012).
export function canonicalizeStatusEvent(e: StatusEventForHash): string {
  return (
    field(e.tenantId) +
    field(e.invoiceId) +
    field(String(e.seq)) +
    field(e.fromStatus) +
    field(e.toStatus) +
    field(e.actor) +
    field(e.reason) +
    field(String(e.createdAtMs))
  )
}

// Genesis dérivé du tenant : sha256('factelec:ledger:genesis:v1:'||tenantId).
export function genesisHash(tenantId: string): Buffer {
  return createHash('sha256')
    .update(`factelec:ledger:genesis:v1:${tenantId}`, 'utf8')
    .digest()
}

// hash = sha256(prev_hash ‖ canonical) — concat d'octets, miroir du digest PG.
export function computeEventHash(
  prevHash: Buffer,
  e: StatusEventForHash,
): Buffer {
  return createHash('sha256')
    .update(prevHash)
    .update(canonicalizeStatusEvent(e), 'utf8')
    .digest()
}
