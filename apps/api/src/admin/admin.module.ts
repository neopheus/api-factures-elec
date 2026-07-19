import { Module } from '@nestjs/common'
import { UsersModule } from '../users/users.module.js'
import { AdminController } from './admin.controller.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'
import { AdminSupervisionRepository } from './admin-supervision.repository.js'
import { SuspensionGuard } from './suspension.guard.js'

// UsersModule : SessionService/SessionGuard/CsrfGuard — CE DERNIER désormais
// UTILISÉ ici (Task 4, POST suspend/unsuspend, spec §2 "CsrfGuard sur les
// POST"), contrairement au commentaire historique (login/logout/GET seuls
// avant cette tâche).
@Module({
  imports: [UsersModule],
  controllers: [AdminController],
  // AdminSupervisionRepository dépend de TenantContextService/APP_POOL,
  // exportés par DbModule (@Global — pas d'import explicite requis ici,
  // même convention que les autres repositories du projet).
  providers: [
    AdminService,
    AdminGuard,
    AdminSupervisionRepository,
    SuspensionGuard,
  ],
  // SuspensionGuard + AdminSupervisionRepository exportés (motif
  // BillingModule : BillingRepository + BillingGuard) — InvoicesModule et
  // EreportingModule importent AdminModule pour poser SuspensionGuard sur
  // leurs mutations d'émission (Task 4, spec §4). Aucun cycle : AdminModule
  // n'importe ni InvoicesModule ni EreportingModule (grep vérifié), seulement
  // UsersModule.
  exports: [AdminSupervisionRepository, SuspensionGuard],
})
export class AdminModule {}
