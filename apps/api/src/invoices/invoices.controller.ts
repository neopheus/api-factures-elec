import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import { ApiKeyGuard } from '../auth/api-key.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
// biome-ignore lint/style/useImportType: InvoicesService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { InvoicesService } from './invoices.service.js'

@UseGuards(ApiKeyGuard)
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Post()
  @HttpCode(201)
  ingest(
    @CurrentTenant() tenantId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: string }> {
    return this.invoices.ingest(tenantId, body)
  }
}
