import { Module } from '@nestjs/common'
import { AnnuaireModule } from '../annuaire/annuaire.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { QueueModule } from '../queue/queue.module.js'
import { UsersModule } from '../users/users.module.js'
import { InvoicesController } from './invoices.controller.js'
import { InvoicesRepository } from './invoices.repository.js'
import { InvoicesService } from './invoices.service.js'
import { LifecycleService } from './lifecycle.service.js'
import { RecipientRoutingService } from './recipient-routing.service.js'

// AMENDEMENT N2 (Task 4, plan 3.5, D6) — tranché SUR PIÈCES : `AnnuaireModule`
// importé DIRECTEMENT (plutôt que fournir `RecipientRoutingService` +
// `AnnuaireConsultationService` en providers locaux). Vérifié dans le code
// AVANT câblage — aucun risque de cycle : `AnnuaireModule` exporte déjà
// `AnnuaireConsultationService`, importe `AuthModule`/`UsersModule`/
// `AnnuaireTransportModule`/`ConsentSignatureModule` (aucun n'importe
// `InvoicesModule`), et `InvoicesModule` n'est importé QUE par
// `AppModule`/`LedgerModule` (jamais par `AnnuaireModule` ni ses imports,
// grep vérifié). `RecipientRoutingService` (worker.module.ts) est fourni ICI
// en provider local (motif `PaymentsModule`/`EreportingModule`) : sa 2ᵉ
// dépendance, `InvoicesRepository`, est déjà un provider de ce module.
// `CsrfGuard` N'EST PAS re-déclaré ici (contrairement au texte littéral du
// plan) : `UsersModule` (déjà importé) l'exporte déjà — la route
// `:id/status` (Task lifecycle) le prouve, elle le compose sans qu'il soit
// jamais un provider local d'`InvoicesModule`.
@Module({
  imports: [AuthModule, UsersModule, QueueModule, AnnuaireModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoicesRepository,
    LifecycleService,
    RecipientRoutingService,
    TenantAuthGuard,
    RolesGuard,
  ],
  // InvoicesRepository exporté pour LedgerModule (Task 4 : lecture des
  // événements scellés sous RLS, partagée avec le journal probatoire).
  exports: [InvoicesRepository],
})
export class InvoicesModule {}
