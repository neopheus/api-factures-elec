import { Inject, Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
// biome-ignore lint/style/useImportType: InvoicesRepository résolu par Nest via design:paramtypes.
import { InvoicesRepository } from '../invoices/invoices.repository.js'
// biome-ignore lint/style/useImportType: RecipientRoutingService résolu par Nest via design:paramtypes.
import { RecipientRoutingService } from '../invoices/recipient-routing.service.js'

const RETRY_BATCH = 100

interface PendingRoutingRow {
  tenant_id: string
  id: string
}

// Reprise du routage destinataire best-effort (Task 3, plan 3.4, D7) — comble
// la dette M1/3.3 : `RecipientRoutingService.resolveAndRecord` laisse
// `routing_status='pending'` INCHANGÉ sur erreur opérationnelle et rien ne le
// rejouait. Miroir EXACT d'`ArchiveRetryService.sweepFailedArchives`
// (archive-retry.service.ts) : SD cross-tenant SECURITY DEFINER
// (`find_pending_routing_invoices`, migration 0028), rejeu DIRECT (pas
// d'enfilement — `resolveAndRecord` est idempotent par construction, motif
// ArchiveRetryService/CdvStuckRetryService). Balaie `pending`+`unaddressable`
// ; `ambiguous` (nettoyage opérateur requis) est déjà EXCLU par la SD.
@Injectable()
export class RecipientRoutingRetryService {
  private readonly logger = new Logger(RecipientRoutingRetryService.name)

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly invoicesRepo: InvoicesRepository,
    private readonly routing: RecipientRoutingService,
  ) {}

  async sweepPendingRouting(): Promise<number> {
    const { rows } = await this.pool.query<PendingRoutingRow>(
      'SELECT tenant_id, id FROM find_pending_routing_invoices($1)',
      [RETRY_BATCH],
    )
    for (const row of rows) {
      try {
        const invoice = await this.invoicesRepo.loadCanonical(
          row.tenant_id,
          row.id,
        )
        if (!invoice) continue
        await this.routing.resolveAndRecord(row.tenant_id, row.id, invoice)
        // AMENDEMENT M-D7-1 (BINDING, anti-famine) : le chemin d'erreur
        // OPÉRATIONNELLE de `resolveAndRecord` n'écrit RIEN (routing_status
        // reste 'pending', updated_at non bumpé) — sans ce touch, une facture
        // en échec opérationnel PERSISTANT resterait EN TÊTE de file
        // (ORDER BY updated_at) et hot-looperait, affamant les suivantes.
        // Ce n'est PAS un changement d'état : écrasement même-valeur
        // ('pending' → 'pending'), seul `updated_at` est bumpé
        // (markRoutingStatus, invoices.repository.ts) → la facture repart en
        // fin de file, la gate de fraîcheur 15 min espace les retentatives.
        const state = await this.invoicesRepo.findRoutingState(
          row.tenant_id,
          row.id,
        )
        if (state?.status === 'pending') {
          await this.invoicesRepo.markRoutingStatus(
            row.tenant_id,
            row.id,
            'pending',
          )
        }
      } catch (err) {
        // Best-effort STRICT (D7) : la boucle ne throw JAMAIS — une ligne en
        // échec ne bloque jamais les suivantes (aucune famine).
        this.logger.error(
          `recipient routing retry failed for ${row.id}`,
          err as Error,
        )
      }
    }
    if (rows.length > 0) {
      this.logger.log(`routing retry: ${rows.length} invoice(s)`)
    }
    return rows.length
  }
}
