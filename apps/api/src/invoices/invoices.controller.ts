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
import {
  ApiBearerAuth,
  ApiBody,
  ApiExcludeEndpoint,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import type { Response } from 'express'
import { z } from 'zod'
import { SuspensionGuard } from '../admin/suspension.guard.js'
import { ApiKeyGuard } from '../auth/api-key.guard.js'
import type { AuthenticatedUser } from '../auth/auth.types.js'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { BillingGuard } from '../billing/billing.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { parseBody, parseQuery } from '../common/validation.js'
import { routingStatus as routingStatusEnum } from '../db/schema.js'
import { parseFormatKind } from './format-kind.js'
import {
  FORMAT_PARAM,
  GET_FORMAT_OPERATION,
  GET_FORMAT_RESPONSE,
  GET_OPERATION,
  GET_RESPONSE,
  GET_STATUS_OPERATION,
  GET_STATUS_RESPONSE,
  ID_PARAM,
  INGEST_BODY_OPTIONS,
  INGEST_CONFLICT_RESPONSE,
  INGEST_CREATED_RESPONSE,
  INGEST_OPERATION,
  INGEST_PAYMENT_REQUIRED_RESPONSE,
  INGEST_SUSPENDED_RESPONSE,
  INGEST_VALIDATION_RESPONSE,
  INVOICE_NOT_FOUND_RESPONSE,
  LIST_CURSOR_QUERY,
  LIST_LIMIT_QUERY,
  LIST_OPERATION,
  LIST_RESPONSE,
  LIST_ROUTING_STATUS_QUERY,
  UNAUTHORIZED_RESPONSE,
} from './invoices.openapi-metadata.js'
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
@ApiTags('Factures')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly lifecycle: LifecycleService,
  ) {}

  // BillingGuard (Task 8, plan phase 5) APRÈS ApiKeyGuard : dépend de
  // `req.tenantId`, posé par ApiKeyGuard — bloque en 402 le dépôt d'une
  // nouvelle facture si l'abonnement du tenant n'est pas valide (`fail-open`
  // uniquement en driver 'none' ou enforcement 'off', jamais silencieusement
  // ailleurs).
  // SuspensionGuard (Task 4, phase 5 it.2, spec §4) EN DERNIER : dépend lui
  // aussi de `req.tenantId` — bloque en 403 (jamais 402, motif tenant-
  // suspended) si l'opérateur a suspendu le tenant. Contrairement à
  // BillingGuard, AUCUNE échappatoire de configuration (driver/enforcement) :
  // s'applique toujours, cf. commentaire de classe `SuspensionGuard`.
  @Post()
  @HttpCode(201)
  @UseGuards(ApiKeyGuard, BillingGuard, SuspensionGuard)
  @ApiBearerAuth('ApiKey')
  @ApiOperation(INGEST_OPERATION)
  @ApiBody(INGEST_BODY_OPTIONS)
  @ApiResponse(INGEST_CREATED_RESPONSE)
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  @ApiResponse(INGEST_PAYMENT_REQUIRED_RESPONSE)
  @ApiResponse(INGEST_SUSPENDED_RESPONSE)
  @ApiResponse(INGEST_CONFLICT_RESPONSE)
  @ApiResponse(INGEST_VALIDATION_RESPONSE)
  ingest(
    @CurrentTenant() tenantId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; status: string }> {
    return this.invoices.ingest(tenantId, body)
  }

  @Get()
  @UseGuards(TenantAuthGuard)
  @ApiBearerAuth('ApiKey')
  @ApiOperation(LIST_OPERATION)
  @ApiQuery(LIST_LIMIT_QUERY)
  @ApiQuery(LIST_CURSOR_QUERY)
  @ApiQuery(LIST_ROUTING_STATUS_QUERY)
  @ApiResponse(LIST_RESPONSE)
  @ApiResponse(UNAUTHORIZED_RESPONSE)
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
  @ApiBearerAuth('ApiKey')
  @ApiOperation(GET_OPERATION)
  @ApiParam(ID_PARAM)
  @ApiResponse(GET_RESPONSE)
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  @ApiResponse(INVOICE_NOT_FOUND_RESPONSE)
  get(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.invoices.get(tenantId, id)
  }

  // @Res() court-circuite la sérialisation Nest (nécessaire pour renvoyer des
  // octets bruts) ; les exceptions lancées AVANT res.send restent captées par
  // ProblemDetailsFilter. Ordre des routes : Nest résout :id/formats/:format
  // sans conflit avec :id (segment supplémentaire).
  @Get(':id/formats/:format')
  @UseGuards(TenantAuthGuard)
  @ApiBearerAuth('ApiKey')
  @ApiOperation(GET_FORMAT_OPERATION)
  @ApiParam(ID_PARAM)
  @ApiParam(FORMAT_PARAM)
  @ApiResponse(GET_FORMAT_RESPONSE)
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  @ApiResponse(INVOICE_NOT_FOUND_RESPONSE)
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
  @ApiExcludeEndpoint()
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
  @ApiBearerAuth('ApiKey')
  @ApiOperation(GET_STATUS_OPERATION)
  @ApiParam(ID_PARAM)
  @ApiResponse(GET_STATUS_RESPONSE)
  @ApiResponse(UNAUTHORIZED_RESPONSE)
  @ApiResponse(INVOICE_NOT_FOUND_RESPONSE)
  getStatus(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.lifecycle.history(tenantId, id)
  }

  // Re-résolution opérateur d'un routage `ambiguous` (Task 4, plan 3.5, D6) —
  // miroir dual-auth EXACT de `PaymentsController.capture` /
  // `EreportingController.retransmit` : `TenantAuthGuard` (clé API OU
  // session) + `RolesGuard`/`CsrfGuard` (s'appliquent SEULEMENT à la
  // session, bypass explicite sur `apiKeyId`). 200 SYNCHRONE (divergence
  // volontaire du 202 `retransmit` — appel direct léger, best-effort, sans
  // enfilement, cf. `InvoicesService.resolveRouting`).
  @Post(':id/routing/resolve')
  @HttpCode(200)
  @UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin', 'accountant')
  @ApiExcludeEndpoint()
  resolveRouting(@CurrentTenant() tenantId: string, @Param('id') id: string) {
    return this.invoices.resolveRouting(tenantId, id)
  }
}
