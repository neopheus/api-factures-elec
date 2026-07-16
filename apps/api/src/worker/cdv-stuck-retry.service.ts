import { Inject, Injectable, Logger } from '@nestjs/common'
import type pg from 'pg'
import type { CdvTarget } from '../cdv/cdv-transmission.repository.js'
// biome-ignore lint/style/useImportType: CdvTransmissionService résolu par Nest via design:paramtypes.
import { CdvTransmissionService } from '../cdv/cdv-transmission.service.js'
import { APP_POOL } from '../db/client.js'
import type { LifecycleStatus } from '../invoices/lifecycle-status.js'

// Batch borné (amendement A5 — miroir ArchiveRetryService.RETRY_BATCH, 2.2) :
// le stuck-retry ne « rattrape » jamais un historique entier de `parked` en
// un seul passage.
const RETRY_BATCH = 100

interface ParkedCdvTransmissionRow {
  tenant_id: string
  invoice_id: string
  to_status: LifecycleStatus
  target: CdvTarget
  status_horodate: string
}

// Reprise des transmissions CDV `parked` (destinataire non
// adressable/ambigu à l'émission, D6 — Task 7, amendement A5). Miroir EXACT
// `ArchiveRetryService.sweepFailedArchives` (2.2) : cross-tenant via SD
// SECURITY DEFINER (`find_parked_cdv_transmissions`, migration 0023), appel
// DIRECT du service métier — PAS d'enfilement sur une file (contrairement à
// `AnnuaireSweepService.sweepStuckDrafts`, 2.4, qui enfile un job
// `annuaire-republish`) : `CdvTransmissionService.transmitStatus` est
// idempotent PAR CONSTRUCTION (insert `created:false` + trackingRef
// write-once, D8), un rejeu direct dans CE process (worker) suffit — la
// résolution annuaire est retentée EN PLACE : si toujours non
// adressable/ambigu, la ligne reste `parked` (no-op journalisé, Task 6) ; si
// désormais résolue, `transmitted` (avec `xml`/`recipientMatricule`
// persistés, injection revue T6 F1/F2).
@Injectable()
export class CdvStuckRetryService {
  private readonly logger = new Logger(CdvStuckRetryService.name)

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly cdvService: CdvTransmissionService,
  ) {}

  // Renvoie le nombre de transmissions `parked` retentées — PAS le nombre
  // effectivement résolues vers `transmitted` (certaines peuvent rester
  // `parked`, motif EreportingSweepService : le sweep ne fait qu'énumérer +
  // rejouer, `transmitStatus` décide du résultat).
  async retryParked(): Promise<number> {
    const { rows } = await this.pool.query<ParkedCdvTransmissionRow>(
      'SELECT tenant_id, invoice_id, to_status, target, status_horodate FROM find_parked_cdv_transmissions($1)',
      [RETRY_BATCH],
    )
    for (const row of rows) {
      // `status_horodate` est déjà le texte AAAAMMJJHHMMSS PERSISTÉ à la
      // genèse de la ligne (colonne cdv_transmissions.status_horodate) —
      // AUCUNE reconversion depuis un timestamptz ici (contrairement au
      // sweep initial, cdv-transmission-sweep.service.ts, qui lit
      // invoice_status_events.created_at, amendement A5).
      await this.cdvService.transmitStatus(
        row.tenant_id,
        row.invoice_id,
        row.to_status,
        row.target,
        row.status_horodate,
      )
    }
    if (rows.length > 0) {
      this.logger.log(
        `cdv stuck-retry: ${rows.length} transmission(s) parked retried`,
      )
    }
    return rows.length
  }
}
