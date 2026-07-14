import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import type { Job } from 'bullmq'
import { RECONCILE_INVOICES_JOB } from '../queue/maintenance.job.js'
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js'
// biome-ignore lint/style/useImportType: InvoiceReconciliationService résolu par Nest via design:paramtypes.
import { InvoiceReconciliationService } from './invoice-reconciliation.service.js'

// Processor UNIQUE de la file `maintenance` : les jobs de maintenance
// (réconciliation ici ; purge de sessions à venir, Task 7) se distinguent
// par `job.name` DANS ce même processor. NE JAMAIS ajouter un second
// `@Processor(MAINTENANCE_QUEUE)` ailleurs : BullMQ ferait alors tourner deux
// Workers indépendants sur la MÊME file, qui se disputent les jobs sans
// routage par nom — un job `purge-sessions` pourrait être pris par CE
// processor, qui l'ignorerait silencieusement (branche par défaut ci-
// dessous) sans jamais le traiter réellement. Task 7 doit AJOUTER une
// branche `else if (job.name === PURGE_SESSIONS_JOB)` ici, pas créer un
// fichier concurrent.
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name)

  constructor(private readonly reconciliation: InvoiceReconciliationService) {
    super()
  }

  async process(job: Job): Promise<void> {
    if (job.name === RECONCILE_INVOICES_JOB) {
      const n = await this.reconciliation.sweepStuckReceived()
      this.logger.log(`reconciliation sweep: ${n} invoice(s) re-enqueued`)
      return
    }
    this.logger.warn(`unknown maintenance job: ${job.name}`)
  }
}
