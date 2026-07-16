import { Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL, createPool } from './client.js'
import { TenantContextService } from './tenant-context.service.js'

@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) =>
        createPool(config.get('DATABASE_URL', { infer: true })),
    },
    TenantContextService,
  ],
  exports: [APP_POOL, TenantContextService],
})
export class DbModule implements OnModuleDestroy {
  private ended = false

  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  // Garde d'idempotence (D10) : `pg-pool` rejette « Called end on pool more
  // than once » si `end()` est rappelé — NestJS peut invoquer les hooks de
  // shutdown plusieurs fois selon la combinaison de signaux OS reçus.
  async onModuleDestroy(): Promise<void> {
    if (this.ended) return
    this.ended = true
    await this.pool.end() // fermeture du pool à l'arrêt (enableShutdownHooks)
  }
}
