import { Injectable } from '@nestjs/common'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: résolus par Nest via design:paramtypes.
import { LedgerVerificationService } from './ledger-verification.service.js'
import type { PafDocument } from './paf.js'

@Injectable()
export class PafService {
  constructor(
    private readonly repo: InvoicesRepository,
    private readonly verification: LedgerVerificationService,
  ) {}

  // null = facture inconnue dans ce tenant (RLS) → 404 anti-fuite, traduit par
  // l'appelant (LedgerController). Rien n'est chargé/vérifié dans ce cas.
  async buildPaf(
    tenantId: string,
    invoiceId: string,
  ): Promise<PafDocument | null> {
    const lifecycleStatus = await this.repo.getLifecycleStatus(
      tenantId,
      invoiceId,
    )
    if (lifecycleStatus === null) return null
    const [events, archive, integrity, chainIntegrity] = await Promise.all([
      this.repo.loadSealedEventsByInvoice(tenantId, invoiceId),
      this.repo.findArchiveState(tenantId, invoiceId),
      // Amendement A-IMPORTANT (revue plan) : integrity (self-check
      // par-facture) NE détecte PAS une suppression owner-side de maillon —
      // chainIntegrity (chaîne COMPLÈTE du tenant) la révèle.
      this.verification.verifyInvoiceEvents(tenantId, invoiceId),
      this.verification.verifyTenantChain(tenantId),
    ])
    return {
      invoiceId,
      lifecycleStatus,
      integrity,
      chainIntegrity,
      archive: archive ?? { status: 'pending', location: null, hash: null },
      // Identité probative = (tenant_id, seq) : `id` (PK surrogate) reste
      // HORS périmètre — jamais sérialisé ici.
      events: events.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
        prevHash: e.prevHash.toString('hex'),
        hash: e.hash.toString('hex'),
      })),
    }
  }
}
