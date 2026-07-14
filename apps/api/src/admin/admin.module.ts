import { Module } from '@nestjs/common'
import { UsersModule } from '../users/users.module.js'
import { AdminController } from './admin.controller.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'

@Module({
  imports: [UsersModule], // SessionService/SessionGuard (CsrfGuard exporté par UsersModule, non utilisé ici : /admin/* n'a aucune route mutante protégée par double-submit CSRF)
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
