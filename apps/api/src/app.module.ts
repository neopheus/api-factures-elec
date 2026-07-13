import { Module } from '@nestjs/common'
import { AppConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { HealthModule } from './health/health.module.js'
import { AppLoggerModule } from './logging/logger.module.js'

@Module({ imports: [AppConfigModule, AppLoggerModule, DbModule, HealthModule] })
export class AppModule {}
