import { Module } from '@nestjs/common'
import { QueueModule } from '../queue/queue.module.js'
import { UsersModule } from '../users/users.module.js'
import { AdminController } from './admin.controller.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'
import { AdminJobsService } from './admin-jobs.service.js'
import { AdminSupervisionRepository } from './admin-supervision.repository.js'
import { SuspensionGuard } from './suspension.guard.js'
import { TotpService } from './totp.service.js'

// UsersModule : SessionService/SessionGuard/CsrfGuard — CE DERNIER désormais
// UTILISÉ ici (Task 4, POST suspend/unsuspend, spec §2 "CsrfGuard sur les
// POST"), contrairement au commentaire historique (login/logout/GET seuls
// avant cette tâche).
// QueueModule (Task 5, spec §3) : requis pour `AdminJobsService`, qui
// injecte via `@InjectQueue` les 5 files de l'allowlist
// (queue.constants.ts) — motif HealthModule/InvoicesModule/EreportingModule
// (chacun importe QueueModule directement pour la même raison, aucune
// re-export en cascade nécessaire au-delà d'un niveau).
@Module({
  imports: [UsersModule, QueueModule],
  controllers: [AdminController],
  // AdminSupervisionRepository dépend de TenantContextService/APP_POOL,
  // exportés par DbModule (@Global — pas d'import explicite requis ici,
  // même convention que les autres repositories du projet).
  providers: [
    AdminService,
    AdminGuard,
    AdminSupervisionRepository,
    SuspensionGuard,
    AdminJobsService,
    // Task 7 (spec §5) : MFA TOTP — consommé UNIQUEMENT par AdminService,
    // pas exporté (même convention que AdminJobsService ci-dessus).
    TotpService,
  ],
  // SuspensionGuard + AdminSupervisionRepository exportés (motif
  // BillingModule : BillingRepository + BillingGuard) — InvoicesModule et
  // EreportingModule importent AdminModule pour poser SuspensionGuard sur
  // leurs mutations d'émission (Task 4, spec §4). Aucun cycle : AdminModule
  // n'importe ni InvoicesModule ni EreportingModule (grep vérifié) — QueueModule
  // (ajouté Task 5) n'importe lui-même ni l'un ni l'autre non plus, grep
  // vérifié également. AdminJobsService n'est PAS exporté (motif AdminGuard :
  // consommé UNIQUEMENT par AdminController, dans ce même module).
  exports: [AdminSupervisionRepository, SuspensionGuard],
})
export class AdminModule {}
