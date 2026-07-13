import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module.js'
import { INVOICE_FORMAT_GENERATOR } from './format-generator.port.js'
import { InvoicesController } from './invoices.controller.js'
import { InvoicesRepository } from './invoices.repository.js'
import { InvoicesService } from './invoices.service.js'
import { SynchronousFormatGenerator } from './synchronous-format-generator.js'

@Module({
  imports: [AuthModule],
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoicesRepository,
    { provide: INVOICE_FORMAT_GENERATOR, useClass: SynchronousFormatGenerator },
  ],
})
export class InvoicesModule {}
