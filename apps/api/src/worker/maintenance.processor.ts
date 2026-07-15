import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import {
  ARCHIVE_RETRY_JOB,
  PURGE_SESSIONS_JOB,
  RECONCILE_INVOICES_JOB,
} from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'
// biome-ignore lint/style/useImportType: ArchiveRetryService résolu par Nest via design:paramtypes.
import { ArchiveRetryService } from './archive-retry.service.js'
// biome-ignore lint/style/useImportType: InvoiceReconciliationService résolu par Nest via design:paramtypes.
import { InvoiceReconciliationService } from './invoice-reconciliation.service.js'
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
    this.logger.warn(`unknown maintenance job: ${job.name}`)
  }
}
