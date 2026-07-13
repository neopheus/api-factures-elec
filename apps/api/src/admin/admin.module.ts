import { Module } from '@nestjs/common'
import { UsersModule } from '../users/users.module.js'
import { AdminController } from './admin.controller.js'
import { AdminGuard } from './admin.guard.js'
import { AdminService } from './admin.service.js'

@Module({
  imports: [UsersModule], // SessionService/SessionGuard/CsrfGuard
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
