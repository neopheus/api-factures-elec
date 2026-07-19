import { Module } from '@nestjs/common'
import { AnnuaireRepository } from '../annuaire/annuaire.repository.js'
import { AnnuaireConsultationService } from '../annuaire/annuaire-consultation.service.js'
import { AnnuairePublicationService } from '../annuaire/annuaire-publication.service.js'
import { AnnuaireSyncService } from '../annuaire/annuaire-sync.service.js'
import { AnnuaireTransportModule } from '../annuaire/annuaire-transport.module.js'
import { ConsentSignatureModule } from '../annuaire/consent-signature.module.js'
import { ArchiveModule } from '../archive/archive.module.js'
import { ArchiveService } from '../archive/archive.service.js'
import { BillingRepository } from '../billing/billing.repository.js'
import { BillingPortModule } from '../billing/billing-port.module.js'
import { CdvTransmissionModule } from '../cdv/cdv-transmission.module.js'
import { CdvTransmissionRepository } from '../cdv/cdv-transmission.repository.js'
import { CdvTransmissionService } from '../cdv/cdv-transmission.service.js'
import { AppConfigModule } from '../config/config.module.js'
import { DbModule } from '../db/db.module.js'
import { EreportingRepository } from '../ereporting/ereporting.repository.js'
import { EreportingGenerationService } from '../ereporting/ereporting-generation.service.js'
import { EreportingTransmissionModule } from '../ereporting/ereporting-transmission.module.js'
import { FormatGenerationService } from '../invoices/format-generation.service.js'
import { INVOICE_FORMAT_GENERATOR } from '../invoices/format-generator.port.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { RecipientRoutingService } from '../invoices/recipient-routing.service.js'
import { PaymentsRepository } from '../payments/payments.repository.js'
import { AnnuaireScheduler } from './annuaire.scheduler.js'
import { AnnuaireSweepService } from './annuaire-sweep.service.js'
import { AnnuaireSyncProcessor } from './annuaire-sync.processor.js'
import { ArchiveRetryScheduler } from './archive-retry.scheduler.js'
import { ArchiveRetryService } from './archive-retry.service.js'
import { BillingUsageScheduler } from './billing-usage.scheduler.js'
import { BillingUsageService } from './billing-usage.service.js'
import { CdvStuckRetryService } from './cdv-stuck-retry.service.js'
import { CdvTransmissionProcessor } from './cdv-transmission.processor.js'
import { CdvTransmissionScheduler } from './cdv-transmission.scheduler.js'
import { CdvTransmissionSweepService } from './cdv-transmission-sweep.service.js'
import { EreportingScheduler } from './ereporting.scheduler.js'
import { EreportingGenerationProcessor } from './ereporting-generation.processor.js'
import { EreportingSweepService } from './ereporting-sweep.service.js'
import { InvoiceGenerationProcessor } from './invoice-generation.processor.js'
import { InvoiceReconciliationService } from './invoice-reconciliation.service.js'
import { MaintenanceProcessor } from './maintenance.processor.js'
import { RecipientRoutingRetryService } from './recipient-routing-retry.service.js'
import { ReconciliationScheduler } from './reconciliation.scheduler.js'
import { RoutingRetryScheduler } from './routing-retry.scheduler.js'
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
    DbModule.forRoot('DATABASE_URL_WORKER'),
    WorkerQueueModule,
    ArchiveModule,
    EreportingTransmissionModule,
    // `@Global()` (annuaire-transport.module.ts) : importer ICI suffit à
    // exposer `ANNUAIRE_TRANSPORT` à tout CE process worker — motif
    // `EreportingTransmissionModule` ci-dessus (le @Global d'un module
    // s'applique à l'arbre bootstrapé qui l'importe, PAS globalement entre
    // deux `NestFactory` distincts : AppModule (HTTP) et WorkerModule sont
    // deux contextes séparés, chacun doit l'importer lui-même).
    AnnuaireTransportModule,
    // `@Global()` (consent-signature.module.ts, Task 1, plan 3.5) : requis
    // par `AnnuairePublicationService` (ci-dessous, `republishDraft` — le
    // sweep de reprise), qui dépend maintenant de `CONSENT_SIGNATURE` dans
    // son constructeur (Task 2, plan 3.5) même si `republishDraft` ne
    // l'appelle jamais (seule la branche `proof` de `resolveConsent` le
    // fait, jamais exercée par le worker) — la résolution DI de Nest est
    // par CONSTRUCTEUR, pas par méthode : le token doit être disponible dans
    // CE process worker, même motif que les deux imports ci-dessus.
    ConsentSignatureModule,
    // `@Global()` (cdv-transmission.module.ts, Task 5) : importer ICI expose
    // `CDV_TRANSMISSION` à ce process worker (Task 7) — même motif que les
    // deux imports ci-dessus.
    CdvTransmissionModule,
    // `@Global()` (billing-port.module.ts, Task 3, plan phase 5) : importer
    // ICI expose `BILLING_PORT` à ce process worker (Task 9, sweep d'usage) —
    // même motif que les trois imports ci-dessus. `BillingModule` (câblage
    // HTTP checkout/portal/webhook) n'est PAS importé ici : ses controllers
    // sont hors de propos pour un `NestFactory.createApplicationContext`
    // (worker-main.ts, sans HTTP), et `BillingRepository` est fourni
    // directement en provider ci-dessous — motif `EreportingRepository`/
    // `AnnuaireRepository`/`CdvTransmissionRepository`, jamais importés via
    // leur module HTTP respectif non plus.
    BillingPortModule,
  ],
  providers: [
    InvoicesRepository,
    PaymentsRepository,
    { provide: INVOICE_FORMAT_GENERATOR, useClass: FormatGenerationService },
    ArchiveService,
    RecipientRoutingService,
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
    AnnuaireRepository,
    AnnuairePublicationService,
    AnnuaireSyncService,
    AnnuaireSweepService,
    AnnuaireScheduler,
    AnnuaireSyncProcessor,
    AnnuaireConsultationService,
    CdvTransmissionRepository,
    CdvTransmissionService,
    CdvTransmissionSweepService,
    CdvStuckRetryService,
    CdvTransmissionScheduler,
    CdvTransmissionProcessor,
    RecipientRoutingRetryService,
    RoutingRetryScheduler,
    BillingRepository,
    BillingUsageService,
    BillingUsageScheduler,
  ],
})
export class WorkerModule {}
