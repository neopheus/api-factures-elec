import { Module } from '@nestjs/common'
import { AppConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { FormatGenerationService } from '../invoices/format-generation.service.js'
import { INVOICE_FORMAT_GENERATOR } from '../invoices/format-generator.port.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { InvoiceGenerationProcessor } from './invoice-generation.processor.js'
import { InvoiceReconciliationService } from './invoice-reconciliation.service.js'
import { MaintenanceProcessor } from './maintenance.processor.js'
import { ReconciliationScheduler } from './reconciliation.scheduler.js'
import { SessionMaintenanceService } from './session-maintenance.service.js'
import { SessionPurgeScheduler } from './session-purge.scheduler.js'
import { WorkerQueueModule } from './worker-queue.module.js'

// Côté CONSOMMATEUR : fournit les @Processor (invoice-generation +
// maintenance) → deux Workers BullMQ démarrent. Importé UNIQUEMENT par
// worker-main.ts (JAMAIS par AppModule) → le process API n'a pas de worker.
// `WorkerQueueModule` (PAS `QueueModule`) : cf. contrat détaillé dans ce
// fichier et dans queue.module.ts — le worker possède sa PROPRE connexion
// BullMQ eager, sans les flags skip* du producteur HTTP.
@Module({
  imports: [AppConfigModule, DbModule, WorkerQueueModule],
  providers: [
    InvoicesRepository,
    { provide: INVOICE_FORMAT_GENERATOR, useClass: FormatGenerationService },
    InvoiceGenerationProcessor,
    InvoiceReconciliationService,
    MaintenanceProcessor,
    ReconciliationScheduler,
    SessionMaintenanceService,
    SessionPurgeScheduler,
  ],
})
export class WorkerModule {}
