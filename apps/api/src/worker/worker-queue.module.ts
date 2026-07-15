import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ConnectionOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { invoiceGenerationJobOptions } from '../queue/invoice-generation.job-options.js'
import { InvoiceGenerationQueue } from '../queue/invoice-generation.queue.js'
import {
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
  ],
  providers: [InvoiceGenerationQueue],
  exports: [BullModule, InvoiceGenerationQueue],
})
export class WorkerQueueModule {}
