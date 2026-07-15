import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { type BundleEvent, buildArchiveBundle } from './archive-bundle.js'
import { ARCHIVE_STORE, type ArchiveStore } from './archive-store.port.js'

@Injectable()
export class ArchiveService {
  private readonly logger = new Logger(ArchiveService.name)

  constructor(
    private readonly repo: InvoicesRepository,
    @Inject(ARCHIVE_STORE) private readonly store: ArchiveStore,
  ) {}

  // Best-effort STRICT : n'échoue JAMAIS le flux appelant (génération, D6 —
  // les formats sont déjà `generated` et servis quand ce service est appelé).
  // Idempotent : write-once (Task 5) + head() → un rejeu retombe sur la clé
  // existante sans réécrire.
  //
  // Coût/couplage (perf, D6) : ce service recharge le canonique, les 5
  // formats persistés ET le journal scellé de la facture, puis (re)sérialise
  // le tout — cela allonge la durée du job de génération. Acceptable : appelé
  // APRÈS completeGeneration (découplé du résultat de génération), en dehors
  // du chemin critique servi au client.
  async archiveInvoice(tenantId: string, invoiceId: string): Promise<void> {
    try {
      const canonical = await this.repo.loadCanonical(tenantId, invoiceId)
      if (!canonical) return // facture disparue entre-temps : no-op idempotent.
      const formats = await this.repo.loadAllFormats(tenantId, invoiceId)
      const sealed = await this.repo.loadSealedEventsByInvoice(
        tenantId,
        invoiceId,
      )
      const events: BundleEvent[] = sealed.map((e) => ({
        seq: e.seq,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actor: e.actor,
        reason: e.reason,
        createdAt: e.createdAt.toISOString(),
        prevHash: e.prevHash.toString('hex'),
        hash: e.hash.toString('hex'),
      }))
      const bundle = buildArchiveBundle({
        tenantId,
        invoiceId,
        canonical,
        formats,
        events,
      })
      const head = await this.store.head(bundle.key)
      if (head.exists) {
        await this.repo.markArchiveStatus(
          tenantId,
          invoiceId,
          'archived',
          bundle.key,
          head.hash,
        )
        return
      }
      const put = await this.store.put(bundle.key, bundle.content)
      await this.repo.markArchiveStatus(
        tenantId,
        invoiceId,
        'archived',
        put.location,
        put.hash,
      )
    } catch (e) {
      this.logger.error(`archive failed for ${invoiceId}`, e as Error)
      await this.repo
        .markArchiveStatus(tenantId, invoiceId, 'failed')
        .catch((e2) =>
          this.logger.error(
            `mark archive failed also failed for ${invoiceId}`,
            e2 as Error,
          ),
        )
    }
  }
}
