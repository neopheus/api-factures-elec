import { Module } from '@nestjs/common'
import { RolesGuard } from '../auth/roles.guard.js'
import { UsersModule } from '../users/users.module.js'
import { BillingController } from './billing.controller.js'
import { BillingRepository } from './billing.repository.js'
import { BillingService } from './billing.service.js'
import { BillingPortModule } from './billing-port.module.js'

// Câblage HTTP du domaine billing (Task 6, plan phase 5) — `BillingPortModule`
// (Task 3, `@Global`) n'est encore importé NULLE PART dans l'app (grep
// vérifié) : l'importer ICI est ce qui l'enregistre effectivement dans
// l'arbre Nest et expose `BILLING_PORT` à toute l'app, motif
// `ConsentSignatureModule` importé par `AnnuaireModule`/`WorkerModule` (son
// premier consommateur), jamais par `app.module.ts` directement.
// `SessionGuard`/`CsrfGuard`/`SessionService` ne sont PAS redéclarés ici :
// `UsersModule` les exporte déjà (motif `PaymentsModule`/`InvoicesModule`).
// `RolesGuard` ne dépend que de `Reflector` (built-in Nest) — fourni en
// provider local (même motif, n'est exporté par aucun module).
// `BillingRepository` exporté : consommé par le garde d'enforcement
// (Task 8) et le worker de sweep d'usage (Task 9).
@Module({
  imports: [UsersModule, BillingPortModule],
  controllers: [BillingController],
  providers: [BillingRepository, BillingService, RolesGuard],
  exports: [BillingRepository],
})
export class BillingModule {}
