import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { BillingModule } from '../billing/billing.module.js'
import { QueueModule } from '../queue/queue.module.js'
import { UsersModule } from '../users/users.module.js'
import { EreportingController } from './ereporting.controller.js'
import { EreportingRepository } from './ereporting.repository.js'
import { EreportingRetransmissionService } from './ereporting-retransmission.service.js'
import { EreportingStatusService } from './ereporting-status.service.js'

// TenantAuthGuard dépend d'ApiKeyService (AuthModule) ET de SessionService
// (UsersModule) — les deux imports sont requis (calqué sur LedgerModule/
// InvoicesModule, motif brief Task 4 2.2 : AuthModule seul ne suffit pas,
// SessionService n'y est pas exporté). EreportingRepository n'est fourni par
// AUCUN module existant (jusqu'ici seulement instancié comme provider de
// WorkerModule, hors périmètre HTTP) : le fournir ICI en tant que provider
// (TenantContextService, dont il dépend, est global via DbModule).
// `QueueModule` (plan 3.4, D2, Task 2) : requis pour injecter
// `EreportingGenerationQueue` (producteur du rectificatif RE) dans
// `EreportingRetransmissionService` — motif InvoicesModule. `RolesGuard` ne
// dépend que de `Reflector` (built-in Nest) — fourni en provider local
// (motif PaymentsModule/InvoicesModule) ; `CsrfGuard`/`SessionService` ne
// sont PAS re-déclarés ici : `UsersModule` les exporte déjà.
// `BillingModule` (Task 8) : requis pour résoudre `BillingGuard`, posé sur
// `@Post('retransmissions')` — `BillingModule` l'exporte déjà, aucun cycle
// (il n'importe ni `EreportingModule` ni ses imports, grep vérifié).
@Module({
  imports: [AuthModule, UsersModule, QueueModule, BillingModule],
  controllers: [EreportingController],
  providers: [
    EreportingRepository,
    EreportingStatusService,
    EreportingRetransmissionService,
    TenantAuthGuard,
    RolesGuard,
  ],
  exports: [EreportingStatusService],
})
export class EreportingModule {}
