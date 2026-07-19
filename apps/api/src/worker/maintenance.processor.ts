import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import {
  ANNUAIRE_REPUBLISH_SWEEP_JOB,
  ANNUAIRE_SYNC_DIFF_JOB,
  ANNUAIRE_SYNC_FULL_JOB,
  ARCHIVE_RETRY_JOB,
  BILLING_USAGE_JOB,
  CDV_STUCK_RETRY_JOB,
  CDV_TRANSMISSION_SWEEP_JOB,
  EREPORTING_SWEEP_JOB,
  PURGE_SESSIONS_JOB,
  RECONCILE_INVOICES_JOB,
  ROUTING_RETRY_JOB,
} from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'
// biome-ignore lint/style/useImportType: AnnuaireSweepService résolu par Nest via design:paramtypes.
import { AnnuaireSweepService } from './annuaire-sweep.service.js'
// biome-ignore lint/style/useImportType: ArchiveRetryService résolu par Nest via design:paramtypes.
import { ArchiveRetryService } from './archive-retry.service.js'
// biome-ignore lint/style/useImportType: BillingUsageService résolu par Nest via design:paramtypes.
import { BillingUsageService } from './billing-usage.service.js'
// biome-ignore lint/style/useImportType: CdvStuckRetryService résolu par Nest via design:paramtypes.
import { CdvStuckRetryService } from './cdv-stuck-retry.service.js'
// biome-ignore lint/style/useImportType: CdvTransmissionSweepService résolu par Nest via design:paramtypes.
import { CdvTransmissionSweepService } from './cdv-transmission-sweep.service.js'
// biome-ignore lint/style/useImportType: EreportingSweepService résolu par Nest via design:paramtypes.
import { EreportingSweepService } from './ereporting-sweep.service.js'
// biome-ignore lint/style/useImportType: InvoiceReconciliationService résolu par Nest via design:paramtypes.
import { InvoiceReconciliationService } from './invoice-reconciliation.service.js'
// biome-ignore lint/style/useImportType: RecipientRoutingRetryService résolu par Nest via design:paramtypes.
import { RecipientRoutingRetryService } from './recipient-routing-retry.service.js'
// biome-ignore lint/style/useImportType: SessionMaintenanceService résolu par Nest via design:paramtypes.
import { SessionMaintenanceService } from './session-maintenance.service.js'

// Processor UNIQUE de la file `maintenance` : les jobs de maintenance
// (réconciliation, purge de sessions — Task 7) se distinguent par `job.name`
// DANS ce même processor. NE JAMAIS ajouter un second
// `@Processor(MAINTENANCE_QUEUE)` ailleurs : BullMQ ferait alors tourner deux
// Workers indépendants sur la MÊME file, qui se disputent les jobs sans
// routage par nom — un job pourrait être pris par le MAUVAIS processor, qui
// l'ignorerait silencieusement (branche par défaut ci-dessous) sans jamais le
// traiter réellement. Toute nouvelle famille de jobs de maintenance doit
// AJOUTER une branche ici, jamais créer un fichier concurrent.
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name)

  constructor(
    private readonly reconciliation: InvoiceReconciliationService,
    private readonly sessionMaintenance: SessionMaintenanceService,
    private readonly archiveRetry: ArchiveRetryService,
    private readonly ereportingSweep: EreportingSweepService,
    private readonly annuaireSweep: AnnuaireSweepService,
    private readonly cdvSweep: CdvTransmissionSweepService,
    private readonly cdvStuckRetry: CdvStuckRetryService,
    private readonly routingRetry: RecipientRoutingRetryService,
    private readonly billingUsage: BillingUsageService,
  ) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === RECONCILE_INVOICES_JOB) {
      const n = await this.reconciliation.sweepStuckGeneration()
      this.logger.log(`reconciliation sweep: ${n} invoice(s) re-enqueued`)
      return
    }
    if (job.name === PURGE_SESSIONS_JOB) {
      const n = await this.sessionMaintenance.purgeExpiredSessions()
      this.logger.log(`purged ${n} expired session(s)`)
      return
    }
    if (job.name === ARCHIVE_RETRY_JOB) {
      const n = await this.archiveRetry.sweepFailedArchives()
      this.logger.log(`archive retry sweep: ${n} invoice(s)`)
      return
    }
    if (job.name === EREPORTING_SWEEP_JOB) {
      const n = await this.ereportingSweep.sweep()
      this.logger.log(`ereporting sweep: ${n} declarant×period job(s)`)
      return
    }
    if (job.name === ANNUAIRE_SYNC_DIFF_JOB) {
      const n = await this.annuaireSweep.sweepSync('D')
      this.logger.log(`annuaire sync sweep (D): ${n} tenant job(s)`)
      return
    }
    if (job.name === ANNUAIRE_SYNC_FULL_JOB) {
      const n = await this.annuaireSweep.sweepSync('C')
      this.logger.log(`annuaire sync sweep (C): ${n} tenant job(s)`)
      return
    }
    if (job.name === ANNUAIRE_REPUBLISH_SWEEP_JOB) {
      const n = await this.annuaireSweep.sweepStuckDrafts()
      this.logger.log(`annuaire stuck-draft sweep: ${n} republish job(s)`)
      return
    }
    if (job.name === CDV_TRANSMISSION_SWEEP_JOB) {
      const n = await this.cdvSweep.sweep()
      this.logger.log(`cdv sweep: ${n} event×cible job(s)`)
      return
    }
    if (job.name === CDV_STUCK_RETRY_JOB) {
      const n = await this.cdvStuckRetry.retryParked()
      this.logger.log(`cdv stuck-retry: ${n} transmission(s)`)
      return
    }
    if (job.name === ROUTING_RETRY_JOB) {
      const n = await this.routingRetry.sweepPendingRouting()
      this.logger.log(`routing retry sweep: ${n} invoice(s)`)
      return
    }
    if (job.name === BILLING_USAGE_JOB) {
      // Pas de log ici (M13) : `BillingUsageService.sweep()` journalise déjà
      // le même résumé (tenants/lignes reportées) — un second log ici serait
      // un pur doublon, motif de la revue finale phase 5.
      await this.billingUsage.sweep()
      return
    }
    this.logger.warn(`unknown maintenance job: ${job.name}`)
  }
}
