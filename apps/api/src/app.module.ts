import { Module } from '@nestjs/common'
import { ApiKeysModule } from './api-keys/api-keys.module.js'
import { AuthModule } from './auth/auth.module.js'
import { AppConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'
import { InvoicesModule } from './invoices/invoices.module.js'
import { AppLoggerModule } from './logging/logger.module.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DbModule,
    AuthModule,
    HealthModule,
    InvoicesModule,
    UsersModule,
    ApiKeysModule,
  ],
})
export class AppModule {}
