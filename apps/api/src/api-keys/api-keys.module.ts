import { Module } from '@nestjs/common'
import { RolesGuard } from '../auth/roles.guard.js'
import { UsersModule } from '../users/users.module.js'
import { ApiKeysController } from './api-keys.controller.js'
import { ApiKeysService } from './api-keys.service.js'

@Module({
  imports: [UsersModule], // SessionGuard/CsrfGuard/SessionService
  controllers: [ApiKeysController],
  providers: [ApiKeysService, RolesGuard],
})
export class ApiKeysModule {}
