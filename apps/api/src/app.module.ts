import { Module } from '@nestjs/common'
import { AuthModule } from './auth/auth.module.js'
import { AppConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'
import { InvoicesModule } from './invoices/invoices.module.js'
import { AppLoggerModule } from './logging/logger.module.js'

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DbModule,
    AuthModule,
    HealthModule,
    InvoicesModule,
  ],
})
export class AppModule {}
