import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { QueueModule } from '../queue/queue.module.js'
import { UsersModule } from '../users/users.module.js'
import { InvoicesController } from './invoices.controller.js'
import { InvoicesRepository } from './invoices.repository.js'
import { InvoicesService } from './invoices.service.js'
import { LifecycleService } from './lifecycle.service.js'

@Module({
  imports: [AuthModule, UsersModule, QueueModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoicesRepository,
    LifecycleService,
    TenantAuthGuard,
    RolesGuard,
  ],
})
export class InvoicesModule {}
