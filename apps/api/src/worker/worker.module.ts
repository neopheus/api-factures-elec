import { Module } from '@nestjs/common'
import { ArchiveModule } from '../archive/archive.module.js'
import { ArchiveService } from '../archive/archive.service.js'
import { AppConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { EreportingRepository } from '../ereporting/ereporting.repository.js'
import { EreportingGenerationService } from '../ereporting/ereporting-generation.service.js'
import { EreportingTransmissionModule } from '../ereporting/ereporting-transmission.module.js'
import { FormatGenerationService } from '../invoices/format-generation.service.js'
import { INVOICE_FORMAT_GENERATOR } from '../invoices/format-generator.port.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { ArchiveRetryScheduler } from './archive-retry.scheduler.js'
import { ArchiveRetryService } from './archive-retry.service.js'
import { EreportingScheduler } from './ereporting.scheduler.js'
import { EreportingGenerationProcessor } from './ereporting-generation.processor.js'
import { EreportingSweepService } from './ereporting-sweep.service.js'
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
  imports: [
    AppConfigModule,
    DbModule,
    WorkerQueueModule,
    ArchiveModule,
    EreportingTransmissionModule,
  ],
  providers: [
    InvoicesRepository,
    { provide: INVOICE_FORMAT_GENERATOR, useClass: FormatGenerationService },
    ArchiveService,
    InvoiceGenerationProcessor,
    InvoiceReconciliationService,
    MaintenanceProcessor,
    ReconciliationScheduler,
    SessionMaintenanceService,
    SessionPurgeScheduler,
    ArchiveRetryService,
    ArchiveRetryScheduler,
    EreportingSweepService,
    EreportingScheduler,
    EreportingRepository,
    EreportingGenerationService,
    EreportingGenerationProcessor,
  ],
})
export class WorkerModule {}
