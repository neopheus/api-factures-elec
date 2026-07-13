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
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end() // fermeture du pool à l'arrêt (enableShutdownHooks)
  }
}
