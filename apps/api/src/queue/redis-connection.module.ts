import { Global, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { ConnectionOptions } from 'bullmq'
import type { EnvConfig } from '../config/env.js'

// Token de la connexion Redis (ConnectionOptions BullMQ). GLOBAL et fourni par
// factory depuis l'env validé, pour être OVERRIDABLE en test (Testcontainers
// Redis à port dynamique) — même stratégie que l'override du provider APP_POOL
// en 1.4 (le port du conteneur n'est pas connu au chargement eager du Config).
export const REDIS_CONNECTION = Symbol('REDIS_CONNECTION')

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CONNECTION,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvConfig, true>,
      ): ConnectionOptions => ({
        host: config.get('REDIS_HOST', { infer: true }),
        port: config.get('REDIS_PORT', { infer: true }),
        db: config.get('REDIS_DB', { infer: true }),
        password: config.get('REDIS_PASSWORD', { infer: true }),
        tls: config.get('REDIS_TLS', { infer: true }) ? {} : undefined,
        // lazyConnect : ne PAS ouvrir la connexion tant qu'aucune commande
        // n'est émise. CRITIQUE pour les tests : dès que QueueModule entre dans
        // AppModule, TOUT test qui monte l'app instancie les files — sans
        // lazyConnect, BullMQ tenterait de joindre un Redis inexistant (retries
        // + erreurs). Avec lazyConnect, seuls les tests qui enfilent/pingent
        // (readiness, ingestion, worker) ouvrent réellement une connexion ; les
        // autres (auth, admin, api-keys, lecture par seed direct) n'y touchent
        // jamais. En prod, la 1re commande (enfilement/ping) connecte — inerte.
        lazyConnect: true,
      }),
    },
  ],
  exports: [REDIS_CONNECTION],
})
export class RedisConnectionModule {}
