import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { InvoicesRepository } from '../invoices/invoices.repository.js'
import { UsersModule } from '../users/users.module.js'
import { PaymentsController } from './payments.controller.js'
import { PaymentsRepository } from './payments.repository.js'
import { PaymentsService } from './payments.service.js'

// Câblage HTTP du domaine paiements (Task 5, plan 3.2) — calqué `CdvModule` :
// `InvoicesRepository` (2.1, 404-first) n'est fourni par AUCUN autre module
// HTTP importé ici → fourni DIRECTEMENT en provider (ne dépend que de
// `TenantContextService`, global via `DbModule`) plutôt que d'importer
// `InvoicesModule` en entier (qui embarquerait des guards/contrôleurs/queue
// étrangers au périmètre de ce module). `TenantAuthGuard` dépend
// d'`ApiKeyService` (`AuthModule`) ET de `SessionService` (`UsersModule`) —
// les deux imports sont requis (même motif `CdvModule`/`EreportingModule`).
// `RolesGuard` ne dépend que de `Reflector` (built-in Nest) — fourni en
// provider local (motif `InvoicesModule`). `CsrfGuard`/`SessionService` ne
// sont PAS re-déclarés ici : `UsersModule` les exporte déjà.
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaymentsRepository,
    InvoicesRepository,
    TenantAuthGuard,
    RolesGuard,
  ],
})
export class PaymentsModule {}
