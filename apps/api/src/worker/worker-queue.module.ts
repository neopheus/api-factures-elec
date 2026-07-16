import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ConnectionOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { annuaireSyncJobOptions } from '../queue/annuaire-sync.job-options.js'
import { ereportingGenerationJobOptions } from '../queue/ereporting-generation.job-options.js'
import { invoiceGenerationJobOptions } from '../queue/invoice-generation.job-options.js'
import { InvoiceGenerationQueue } from '../queue/invoice-generation.queue.js'
import {
  ANNUAIRE_SYNC_QUEUE,
  EREPORTING_GENERATION_QUEUE,
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../queue/queue.constants.js'
import {
  REDIS_CONNECTION,
  RedisConnectionModule,
} from '../queue/redis-connection.module.js'

// Côté CONSOMMATEUR (WorkerModule) : DÉCLARE SON PROPRE
// `BullModule.forRootAsync` — délibérément DISTINCT de celui de QueueModule
// (producteur, Task 1). Contrat inscrit dans queue.module.ts : un Worker
// BullMQ (par opposition à un producteur HTTP) DOIT se connecter EAGER
// (échouer/crash-loop si Redis est injoignable au démarrage, jamais tourner
// silencieusement sans jamais consommer) et bénéficier de la négociation de
// capacités COMPLÈTE (canDoubleTimeout/canBlockFor1Ms — les commandes
// bloquantes qu'un Worker émet, pas un producteur HTTP). AUCUN des deux flags
// `skipWaitingForReady`/`skipVersionCheck` du producteur ici — ne JAMAIS
// réutiliser tel quel le `forRootAsync` du producteur pour ce module.
// `REDIS_CONNECTION`/`RedisConnectionModule` restent réutilisés tels quels
// (simples `ConnectionOptions` ioredis neutres, cf. le contrat).
//
// `registerQueueAsync` pour `invoice-generation` réutilise la MÊME politique
// de job (`invoiceGenerationJobOptions`) que le producteur : un job
// re-enfilé par la réconciliation (qui vit dans CE process, worker) doit
// obéir aux mêmes attempts/backoff/rétention qu'un job enfilé par
// l'ingestion API — jamais de divergence silencieuse entre les deux
// `registerQueue`.
@Module({
  imports: [
    RedisConnectionModule,
    BullModule.forRootAsync({
      inject: [REDIS_CONNECTION],
      useFactory: (connection: ConnectionOptions) => ({ connection }),
    }),
    BullModule.registerQueueAsync({
      name: INVOICE_GENERATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        defaultJobOptions: invoiceGenerationJobOptions(config),
      }),
    }),
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
    // `ereporting-generation` (Task 7, `defaultJobOptions` câblés Task 8) :
    // enregistrée ICI côté worker car c'est le PRODUCTEUR (EreportingSweep
    // Service, `@InjectQueue`) ET, depuis Task 8, le CONSOMMATEUR
    // (EreportingGenerationProcessor, `@Processor`) — jobId déterministe posé
    // explicitement par le sweep (dédup, cf. son commentaire) ;
    // `ereportingGenerationJobOptions` fournit attempts/backoff/rétention
    // (SEULE source de vérité, motif invoice-generation.job-options.ts) —
    // sans quoi un `throw` opérationnel du processeur (XsdToolingError)
    // ne serait JAMAIS rejoué (défaut BullMQ nu : 1 tentative).
    BullModule.registerQueueAsync({
      name: EREPORTING_GENERATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        defaultJobOptions: ereportingGenerationJobOptions(config),
      }),
    }),
    // `annuaire-sync` (Task 9) : même motif que `ereporting-generation`
    // ci-dessus — enregistrée ICI car c'est le PRODUCTEUR
    // (AnnuaireSweepService, `@InjectQueue`) ET le CONSOMMATEUR
    // (AnnuaireSyncProcessor, `@Processor`), tous deux dans CE process
    // (worker). `annuaireSyncJobOptions` fournit attempts/backoff/rétention
    // (SEULE source de vérité) pour les DEUX job.name qui y transitent
    // (ANNUAIRE_SYNC_JOB, ANNUAIRE_REPUBLISH_JOB).
    BullModule.registerQueueAsync({
      name: ANNUAIRE_SYNC_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        defaultJobOptions: annuaireSyncJobOptions(config),
      }),
    }),
  ],
  providers: [InvoiceGenerationQueue],
  exports: [BullModule, InvoiceGenerationQueue],
})
export class WorkerQueueModule {}
