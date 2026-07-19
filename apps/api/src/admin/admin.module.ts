import { Module } from '@nestjs/common'
import { UsersModule } from '../users/users.module.js'
import { AdminController } from './admin.controller.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'
import { AdminSupervisionRepository } from './admin-supervision.repository.js'

@Module({
  imports: [UsersModule], // SessionService/SessionGuard (CsrfGuard exporté par UsersModule, non utilisé ici : /admin/* n'a aucune route mutante protégée par double-submit CSRF)
  controllers: [AdminController],
  // AdminSupervisionRepository dépend de TenantContextService/APP_POOL,
  // exportés par DbModule (@Global — pas d'import explicite requis ici,
  // même convention que les autres repositories du projet).
  providers: [AdminService, AdminGuard, AdminSupervisionRepository],
})
export class AdminModule {}
