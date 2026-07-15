import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { InvoicesModule } from '../invoices/invoices.module.js'
import { UsersModule } from '../users/users.module.js'
import { LedgerController } from './ledger.controller.js'
import { LedgerVerificationService } from './ledger-verification.service.js'

// TenantAuthGuard dépend d'ApiKeyService (AuthModule) ET de SessionService
// (UsersModule) — les deux imports sont requis (calqué sur InvoicesModule,
// qui résout le même guard de la même façon) : AuthModule seul ne suffit pas,
// SessionService n'y est pas exporté (cf. brief Task 4, note d'exécution).
// InvoicesModule fournit InvoicesRepository (exporté depuis Task 4, Step 1).
@Module({
  imports: [AuthModule, UsersModule, InvoicesModule],
  controllers: [LedgerController],
  providers: [LedgerVerificationService, TenantAuthGuard],
})
export class LedgerModule {}
