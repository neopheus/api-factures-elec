import { Inject, Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
// biome-ignore lint/style/useImportType: ArchiveService résolu par Nest via design:paramtypes.
import { ArchiveService } from '../archive/archive.service.js'
import { APP_POOL } from '../db/client.js'

const RETRY_BATCH = 100

interface FailedArchiveRow {
  tenant_id: string
  id: string
}

// Reprise d'archivage best-effort (Task 8) : rejoue `archiveInvoice` sur les
// factures dont l'archivage a échoué (`archive_status='failed'`) OU est resté
// figé en `pending` au-delà de 15 min (double-échec DB rare, cf. migration
// 0015 / find_failed_archives). Idempotent (archiveInvoice : head write-once)
// → aucun risque de doublon/écrasement en cas de rejeu concurrent. Cross-
// tenant via fonction SECURITY DEFINER (même triptyque que
// find_stuck_generation_invoices, 2.1).
@Injectable()
export class ArchiveRetryService {
  private readonly logger = new Logger(ArchiveRetryService.name)

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly archive: ArchiveService,
  ) {}

  async sweepFailedArchives(): Promise<number> {
    const { rows } = await this.pool.query<FailedArchiveRow>(
      'SELECT tenant_id, id FROM find_failed_archives($1)',
      [RETRY_BATCH],
    )
    for (const row of rows) {
      await this.archive.archiveInvoice(row.tenant_id, row.id)
    }
    if (rows.length > 0) {
      this.logger.log(`archive retry: ${rows.length} invoice(s)`)
    }
    return rows.length
  }
}
