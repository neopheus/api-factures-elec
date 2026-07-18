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
import { z } from 'zod'
import { ApiKeyGuard } from '../auth/api-key.guard.js'
import type { AuthenticatedUser } from '../auth/auth.types.js'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { parseBody, parseQuery } from '../common/validation.js'
import { routingStatus as routingStatusEnum } from '../db/schema.js'
import { parseFormatKind } from './format-kind.js'
// biome-ignore lint/style/useImportType: InvoicesService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { InvoicesService } from './invoices.service.js'
// biome-ignore lint/style/useImportType: LifecycleService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { LifecycleService } from './lifecycle.service.js'
import { isLifecycleStatus, type LifecycleStatus } from './lifecycle-status.js'

const transitionSchema = z.object({
  toStatus: z.string().refine(isLifecycleStatus, 'unknown lifecycle status'),
  reason: z.string().min(1).max(1000).optional(),
})

// Source unique (D8, plan 3.4) : l'enum zod dérive de `routingStatus.enumValues`
// (db/schema.ts), jamais d'une liste recopiée — un ajout/retrait de valeur au
// schéma se propage ici automatiquement.
const listQuerySchema = z.object({
  routingStatus: z.enum(routingStatusEnum.enumValues).optional(),
})

// Guards posés PAR MÉTHODE (pas de classe) : l'ingestion (POST) reste
// exclusivement machine (ApiKeyGuard, pas de CSRF — pas de cookie côté
// machine) ; la lecture (GET) accepte clé API OU session utilisateur du même
// tenant (TenantAuthGuard) — jamais une session admin (refusée par ce guard).
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly lifecycle: LifecycleService,
  ) {}

  @Post()
  @HttpCode(201)
  @UseGuards(ApiKeyGuard)
  ingest(
    @CurrentTenant() tenantId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: string }> {
    return this.invoices.ingest(tenantId, body)
  }

  @Get()
  @UseGuards(TenantAuthGuard)
  list(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('routingStatus') routingStatus?: string,
  ) {
    const n = Number(limit)
    const safeLimit = Number.isFinite(n)
      ? Math.min(Math.max(Math.trunc(n), 1), 100)
      : 20
    const query = parseQuery(listQuerySchema, { routingStatus })
    return this.invoices.list(tenantId, safeLimit, cursor, query.routingStatus)
  }

  @Get(':id')
  @UseGuards(TenantAuthGuard)
  get(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.invoices.get(tenantId, id)
  }

  // @Res() court-circuite la sérialisation Nest (nécessaire pour renvoyer des
  // octets bruts) ; les exceptions lancées AVANT res.send restent captées par
  // ProblemDetailsFilter. Ordre des routes : Nest résout :id/formats/:format
  // sans conflit avec :id (segment supplémentaire).
  @Get(':id/formats/:format')
  @UseGuards(TenantAuthGuard)
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

  // Mutation métier : session (owner/admin/accountant) + CSRF. Un viewer est
  // refusé (403) ; une clé API n'ouvre pas cette route (SessionGuard → 401,
  // pas de cookie). L'apposition machine (connecteurs) est différée (phase 3).
  @Post(':id/status')
  @HttpCode(201)
  @UseGuards(SessionGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin', 'accountant')
  recordStatus(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ status: LifecycleStatus }> {
    const { toStatus, reason } = parseBody(transitionSchema, body)
    return this.lifecycle.transition(
      tenantId,
      id,
      toStatus as LifecycleStatus,
      `user:${user.userId}`,
      reason,
    )
  }

  @Get(':id/status')
  @UseGuards(TenantAuthGuard)
  getStatus(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.lifecycle.history(tenantId, id)
  }
}
