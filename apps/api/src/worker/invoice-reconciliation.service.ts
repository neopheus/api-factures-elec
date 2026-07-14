import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL } from '../db/client.js'
// biome-ignore lint/style/useImportType: InvoiceGenerationQueue résolu par Nest via design:paramtypes.
import { InvoiceGenerationQueue } from '../queue/invoice-generation.queue.js'

interface StuckInvoiceRow {
  tenant_id: string
  id: string
}

// Rattrape les factures `received` orphelines : l'enfilement Redis a échoué
// APRÈS la persistance Postgres (cf. commentaire InvoicesService.ingest,
// "réconciliation différée") — aucun job BullMQ ne référence jamais leur id,
// donc aucun retry ne peut les rattraper de lui-même. `queue.enqueue` est
// idempotent (jobId = invoiceId) : si un job existe déjà (traitement en
// cours, ou simple retard du worker sous charge), BullMQ ignore le doublon —
// aucun risque de double génération à re-enfiler une facture qui n'était pas
// réellement orpheline.
@Injectable()
export class InvoiceReconciliationService {
  private readonly logger = new Logger(InvoiceReconciliationService.name)
  private readonly staleMs: number

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly queue: InvoiceGenerationQueue,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.staleMs = config.get('RECONCILIATION_STALE_MS', { infer: true })
  }

  async sweepStuckReceived(): Promise<number> {
    const { rows } = await this.pool.query<StuckInvoiceRow>(
      'SELECT tenant_id, id FROM find_stuck_received_invoices($1)',
      [this.staleMs],
    )
    for (const row of rows) {
      await this.queue.enqueue(row.tenant_id, row.id)
    }
    if (rows.length > 0) {
      this.logger.log(
        `reconciliation: re-enqueued ${rows.length} stuck invoice(s)`,
      )
    }
    return rows.length
  }
}
