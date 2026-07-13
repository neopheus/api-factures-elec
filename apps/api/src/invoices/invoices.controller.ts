import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { ApiKeyGuard } from '../auth/api-key.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { ProblemType, problem } from '../common/problem.js'
import { parseFormatKind } from './format-kind.js'
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

  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const n = Number(limit)
    const safeLimit = Number.isFinite(n)
      ? Math.min(Math.max(Math.trunc(n), 1), 100)
      : 20
    return this.invoices.list(tenantId, safeLimit, cursor)
  }

  @Get(':id')
  get(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.invoices.get(tenantId, id)
  }

  // @Res() court-circuite la sérialisation Nest (nécessaire pour renvoyer des
  // octets bruts) ; les exceptions lancées AVANT res.send restent captées par
  // ProblemDetailsFilter. Ordre des routes : Nest résout :id/formats/:format
  // sans conflit avec :id (segment supplémentaire).
  @Get(':id/formats/:format')
  async getFormat(
    @CurrentTenant() tenantId: string,
    @Param('id') id: string,
    @Param('format') format: string,
    @Res() res: Response,
  ): Promise<void> {
    const kind = parseFormatKind(format)
    if (!kind) {
      throw new NotFoundException(
        problem(404, ProblemType.notFound, 'Unknown format'),
      )
    }
    const f = await this.invoices.getFormat(tenantId, id, kind)
    res.type(f.contentType)
    res.send(f.bodyBytes ?? f.bodyText)
  }
}
