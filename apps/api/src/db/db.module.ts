import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL, createPool } from './client.js'
import { TenantContextService } from './tenant-context.service.js'

// Split pool/rôle par bootstrap disjoint (D5, Task 3, plan 3.5) : l'API
// (`AppModule`) et le worker (`WorkerModule`) démarrent chacun leur PROPRE
// arbre Nest (`main.ts` vs `worker-main.ts`) — jamais les deux dans un même
// process — donc `forRoot(urlEnvKey)` choisit la clé env à la CONSTRUCTION
// du module plutôt qu'un unique `DATABASE_URL` partagé. `DATABASE_URL_WORKER`
// est optionnelle (env.ts) : throw explicite ici si absente au bootstrap
// worker, l'env API n'a pas besoin du secret worker.
@Global()
@Module({})
export class DbModule implements OnModuleDestroy {
  private ended = false

  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  static forRoot(
    urlEnvKey: 'DATABASE_URL' | 'DATABASE_URL_WORKER',
  ): DynamicModule {
    return {
      module: DbModule,
      providers: [
        {
          provide: APP_POOL,
          inject: [ConfigService],
          useFactory: (config: ConfigService<EnvConfig, true>) => {
            const url = config.get(urlEnvKey, { infer: true })
            if (!url) {
              throw new Error(`${urlEnvKey} requis pour le process worker`)
            }
            return createPool(url)
          },
        },
        TenantContextService,
      ],
      exports: [APP_POOL, TenantContextService],
    }
  }

  // Garde d'idempotence (D10) : `pg-pool` rejette « Called end on pool more
  // than once » si `end()` est rappelé — NestJS peut invoquer les hooks de
  // shutdown plusieurs fois selon la combinaison de signaux OS reçus.
  async onModuleDestroy(): Promise<void> {
    if (this.ended) return
    this.ended = true
    await this.pool.end() // fermeture du pool à l'arrêt (enableShutdownHooks)
  }
}
