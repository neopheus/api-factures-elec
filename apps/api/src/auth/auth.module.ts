import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import type { EnvConfig } from '../config/env.js'
import { ApiKeyGuard } from './api-key.guard.js'
import { ApiKeyService } from './api-key.service.js'

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        throttlers: [
          {
            ttl: config.get('RATE_LIMIT_TTL', { infer: true }) * 1000,
            limit: config.get('RATE_LIMIT_LIMIT', { infer: true }),
          },
        ],
      }),
    }),
  ],
  providers: [
    ApiKeyService,
    ApiKeyGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard }, // rate limiting global (par IP en amont de l'auth)
  ],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class AuthModule {}
