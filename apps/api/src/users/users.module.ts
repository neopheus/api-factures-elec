import { Module } from '@nestjs/common'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { SessionService } from '../auth/session.service.js'
import { UsersController } from './users.controller.js'
import { UsersService } from './users.service.js'

@Module({
  controllers: [UsersController],
  providers: [UsersService, SessionService, SessionGuard, CsrfGuard],
  exports: [SessionService, SessionGuard, CsrfGuard],
})
export class UsersModule {}
