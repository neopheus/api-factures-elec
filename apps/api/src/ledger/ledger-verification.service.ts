import { Injectable } from '@nestjs/common'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import {
  InvoicesRepository,
  type SealedEvent,
} from '../invoices/invoices.repository.js'
import {
  computeEventHash,
  genesisHash,
  type StatusEventForHash,
} from './ledger-hash.js'

export type LedgerIntegrity =
  | { valid: true; length: number }
  | {
      valid: false
      brokenAtSeq: number
      reason: 'seq-gap' | 'prev-hash-mismatch' | 'hash-mismatch'
    }

// Miroir Task 3 (cf. ledger-hash.ts, CONTRAT D'ENTRÉE) : reason/fromStatus
// reviennent `null` de pg (jamais `undefined`) ; createdAtMs = getTime() de la
// valeur déjà tronquée à la ms par le trigger DB.
function toHashInput(tenantId: string, ev: SealedEvent): StatusEventForHash {
  return {
    tenantId,
    invoiceId: ev.invoiceId,
    seq: ev.seq,
    fromStatus: ev.fromStatus,
    toStatus: ev.toStatus,
    actor: ev.actor,
    reason: ev.reason,
    createdAtMs: ev.createdAt.getTime(),
  }
}

@Injectable()
export class LedgerVerificationService {
  constructor(private readonly repo: InvoicesRepository) {}

  // Self-check par événement : le hash stocké doit égaler le recompute à
  // partir du prev_hash stocké + champs. Détecte l'altération d'un champ d'un
  // événement, MAIS PAS la suppression d'un maillon (chaque événement restant
  // s'auto-vérifie contre son propre prev_hash stocké, intact) — d'où
  // verifyTenantChain ci-dessous, seul à détecter une suppression owner-side.
  async verifyInvoiceEvents(
    tenantId: string,
    invoiceId: string,
  ): Promise<LedgerIntegrity> {
    const events = await this.repo.loadSealedEventsByInvoice(
      tenantId,
      invoiceId,
    )
    for (const ev of events) {
      const expected = computeEventHash(ev.prevHash, toHashInput(tenantId, ev))
      if (!expected.equals(ev.hash)) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'hash-mismatch' }
      }
    }
    return { valid: true, length: events.length }
  }

  // Chaîne complète du tenant : genesis, contiguïté du seq, linkage prev_hash,
  // hash. Détecte l'altération/suppression/insertion PARTIELLE d'un événement
  // intermédiaire du journal du tenant — notamment la suppression d'un
  // maillon, invisible au self-check par-facture ci-dessus. NE détecte PAS la
  // troncature de la QUEUE de chaîne (supprimer le DERNIER maillon laisse la
  // chaîne 1..n-1 valide) ni une RÉÉCRITURE COMPLÈTE cohérente de toute la
  // chaîne (genesis dérivé du tenant, donc public et recalculable) : ces deux
  // modes sont intrinsèques à tout hash-chain auto-contenu (≠ MAC) et ne sont
  // détectables que par l'ancrage de tête (seq max + hash) dans l'archive
  // WORM externe (adaptateur S3 object-lock, activé au déploiement — cf.
  // README). Scanne TOUS les événements du tenant (O(n)) ; acceptable pour un
  // endpoint d'audit (pas un hot path) — une pagination/borne pourra être
  // ajoutée si un tenant devient très volumineux (différé, non implémenté
  // ici).
  async verifyTenantChain(tenantId: string): Promise<LedgerIntegrity> {
    const events = await this.repo.loadSealedEventsByTenant(tenantId)
    let expectedSeq = 1
    let prevHash: Buffer | null = null
    for (const ev of events) {
      if (ev.seq !== expectedSeq) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'seq-gap' }
      }
      const expectedPrev = prevHash ?? genesisHash(tenantId)
      if (!ev.prevHash.equals(expectedPrev)) {
        return {
          valid: false,
          brokenAtSeq: ev.seq,
          reason: 'prev-hash-mismatch',
        }
      }
      const expectedHash = computeEventHash(
        ev.prevHash,
        toHashInput(tenantId, ev),
      )
      if (!expectedHash.equals(ev.hash)) {
        return { valid: false, brokenAtSeq: ev.seq, reason: 'hash-mismatch' }
      }
      prevHash = ev.hash
      expectedSeq += 1
    }
    return { valid: true, length: events.length }
  }
}
