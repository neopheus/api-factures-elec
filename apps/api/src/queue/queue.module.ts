import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ConnectionOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'
import { invoiceGenerationJobOptions } from './invoice-generation.job-options.js'
import { InvoiceGenerationQueue } from './invoice-generation.queue.js'
import {
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from './queue.constants.js'
import {
  REDIS_CONNECTION,
  RedisConnectionModule,
} from './redis-connection.module.js'

// Côté PRODUCTEUR : connexion partagée + files enregistrées. Importée par
// l'API (enfilement via @InjectQueue) UNIQUEMENT. NE FOURNIT AUCUN @Processor
// → l'importer seul ne fait tourner aucun worker.
//
// CONTRAT POUR LA TÂCHE 3 (WorkerModule) : `skipWaitingForReady` et
// `skipVersionCheck` ci-dessous sont des `Bull.QueueOptions` (cf.
// `BullRootModuleOptions extends Bull.QueueOptions`, @nestjs/bullmq) —
// scopées à CE `forRootAsync` (donc aux deux files enregistrées ci-dessous),
// PAS à `REDIS_CONNECTION` (qui reste un simple `ConnectionOptions` ioredis
// neutre, réutilisable tel quel). Le WorkerModule DOIT déclarer son PROPRE
// `BullModule.forRootAsync` (sa propre config partagée, éventuellement sous
// un `configKey` dédié) SANS ces deux flags : un worker doit se connecter
// EAGER au démarrage (échouer/crash-loop si Redis est injoignable plutôt que
// de tourner silencieusement sans jamais consommer) et bénéficier de la
// négociation de capacités complète (`canDoubleTimeout`/`canBlockFor1Ms`,
// utiles aux commandes bloquantes qu'un Worker émet, pas un producteur). Ne
// JAMAIS réutiliser tel quel ce `forRootAsync` producteur pour le Worker.
@Module({
  imports: [
    RedisConnectionModule,
    BullModule.forRootAsync({
      inject: [REDIS_CONNECTION],
      useFactory: (connection: ConnectionOptions) => ({
        connection,
        // CRITIQUE (validé empiriquement, amendement A2) : `lazyConnect: true`
        // sur les ConnectionOptions (ioredis) est INSUFFISANT. À la
        // construction de chaque Queue, `RedisConnection.init()` de BullMQ
        // appelle `waitUntilReady()` qui, tant que le client est en statut
        // `wait`, invoque elle-même `client.connect()` — ouvrant donc une
        // connexion RÉELLE dès le montage du module, même sans lazyConnect,
        // et même si rien n'enfile ni ne pingue. `skipWaitingForReady: true`
        // fait sauter ce `waitUntilReady()`.
        //
        // INSUFFISANT SEUL (revérifié) : `RedisConnection.init()` appelle
        // ENSUITE, inconditionnellement (si le client n'est pas déjà 'end'),
        // `getRedisVersionAndType()`, qui envoie un `INFO` réel — sauf si
        // `skipVersionCheck` est ÉGALEMENT vrai (elle retourne alors la
        // version plancher sans toucher le réseau). Sans les DEUX flags, un
        // rejet non géré (« Connection is closed ») survient à la fermeture
        // de tout test full-app qui ne touche jamais Redis.
        //
        // Documenté par BullMQ lui-même comme le cas d'usage visé
        // (`queue-options.d.ts`, jsdoc `skipWaitingForReady` : "useful ... when
        // adding jobs via HTTP endpoints") — c'est exactement notre
        // producteur HTTP. Contrepartie acceptée : `skipVersionCheck` fige
        // `capabilities` à la version plancher BullMQ (canDoubleTimeout/
        // canBlockFor1Ms toujours false) pour CE producteur uniquement — sans
        // impact fonctionnel ici (l'API n'émet aucune commande bloquante ;
        // seul un Worker en émet, cf. contrat ci-dessus).
        skipWaitingForReady: true,
        skipVersionCheck: true,
      }),
    }),
    // `defaultJobOptions` (attempts/backoff/rétention) tiré de l'env — cf.
    // `invoice-generation.job-options.ts` : SEULE source de vérité, partagée
    // avec `WorkerQueueModule` (Task 3), pour que le producteur (ingestion)
    // ET le consommateur (réconciliation, worker) appliquent EXACTEMENT la
    // même politique de tentatives à la file `invoice-generation`.
    BullModule.registerQueueAsync({
      name: INVOICE_GENERATION_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        defaultJobOptions: invoiceGenerationJobOptions(config),
      }),
    }),
    // `maintenance` : pas de politique de job dédiée ici (les jobs de
    // maintenance sont posés explicitement par leurs planificateurs, cf.
    // worker/reconciliation.scheduler.ts et, à venir, Task 7).
    BullModule.registerQueue({ name: MAINTENANCE_QUEUE }),
  ],
  providers: [InvoiceGenerationQueue],
  exports: [BullModule, InvoiceGenerationQueue],
})
export class QueueModule {}
