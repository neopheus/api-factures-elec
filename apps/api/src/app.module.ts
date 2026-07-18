import { Module } from '@nestjs/common'
import { AdminModule } from './admin/admin.module.js'
import { AnnuaireModule } from './annuaire/annuaire.module.js'
import { ApiKeysModule } from './api-keys/api-keys.module.js'
import { AuthModule } from './auth/auth.module.js'
import { CdvModule } from './cdv/cdv.module.js'
import { AppConfigModule } from './config/config.module.js'
import { DbModule } from './db/db.module.js'
import { EreportingModule } from './ereporting/ereporting.module.js'
import { HealthModule } from './health/health.module.js'
import { InvoicesModule } from './invoices/invoices.module.js'
import { LedgerModule } from './ledger/ledger.module.js'
import { AppLoggerModule } from './logging/logger.module.js'
import { PaymentsModule } from './payments/payments.module.js'
import { QueueModule } from './queue/queue.module.js'
import { UsersModule } from './users/users.module.js'

@Module({
  imports: [
    AppConfigModule,
    AppLoggerModule,
    DbModule.forRoot('DATABASE_URL'),
    QueueModule,
    AuthModule,
    HealthModule,
    InvoicesModule,
    LedgerModule,
    EreportingModule,
    AnnuaireModule,
    CdvModule,
    PaymentsModule,
    UsersModule,
    ApiKeysModule,
    AdminModule,
  ],
})
export class AppModule {}
