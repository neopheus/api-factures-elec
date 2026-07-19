import { Module } from '@nestjs/common'
import { RolesGuard } from '../auth/roles.guard.js'
import { UsersModule } from '../users/users.module.js'
import { BillingController } from './billing.controller.js'
import { BillingRepository } from './billing.repository.js'
import { BillingService } from './billing.service.js'
import { BillingPortModule } from './billing-port.module.js'
import { BillingWebhookController } from './billing-webhook.controller.js'
import { BillingWebhookService } from './billing-webhook.service.js'

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
// `BillingWebhookController`/`BillingWebhookService` (Task 7) : classe
// séparée de `BillingController` car AUCUN guard (session/CSRF/rôles) ne
// s'applique — l'authenticité vient de la signature Stripe, jamais de la
// session. Câblés ici comme le reste du module HTTP billing.
@Module({
  imports: [UsersModule, BillingPortModule],
  controllers: [BillingController, BillingWebhookController],
  providers: [
    BillingRepository,
    BillingService,
    BillingWebhookService,
    RolesGuard,
  ],
  exports: [BillingRepository],
})
export class BillingModule {}
