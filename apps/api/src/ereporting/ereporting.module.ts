import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { UsersModule } from '../users/users.module.js'
import { EreportingController } from './ereporting.controller.js'
import { EreportingRepository } from './ereporting.repository.js'
import { EreportingStatusService } from './ereporting-status.service.js'

// TenantAuthGuard dépend d'ApiKeyService (AuthModule) ET de SessionService
// (UsersModule) — les deux imports sont requis (calqué sur LedgerModule/
// InvoicesModule, motif brief Task 4 2.2 : AuthModule seul ne suffit pas,
// SessionService n'y est pas exporté). EreportingRepository n'est fourni par
// AUCUN module existant (jusqu'ici seulement instancié comme provider de
// WorkerModule, hors périmètre HTTP) : le fournir ICI en tant que provider
// (TenantContextService, dont il dépend, est global via DbModule).
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [EreportingController],
  providers: [EreportingRepository, EreportingStatusService, TenantAuthGuard],
  exports: [EreportingStatusService],
})
export class EreportingModule {}
