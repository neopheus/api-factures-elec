import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { TenantAuthGuard } from '../auth/tenant-auth.guard.js'
import { parseBody, parseQuery } from '../common/validation.js'
import { AMOUNT_RE, DATE_RE, DECIMAL_RE } from './payment.model.js'
import type { PaymentRow } from './payments.repository.js'
// biome-ignore lint/style/useImportType: PaymentsService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { PaymentsService } from './payments.service.js'

const captureSchema = z.object({
  invoiceId: z.uuid(),
  paymentDate: z
    .string()
    .regex(DATE_RE, 'paymentDate must be AAAAMMJJ (8 digits, valid month/day)'),
  currency: z.string().min(1).optional(),
  reference: z.string().min(1),
  subtotals: z
    .array(
      z.object({
        taxPercent: z
          .string()
          .regex(
            DECIMAL_RE,
            'taxPercent must be a non-negative decimal (up to 4 decimals)',
          ),
        amount: z
          .string()
          .regex(
            AMOUNT_RE,
            'amount must be a non-negative amount with exactly 2 decimals',
          ),
      }),
    )
    .min(1),
})

const listQuerySchema = z.object({
  invoiceId: z.uuid(),
})

// Guards posés PAR MÉTHODE (motif InvoicesController) : la capture (POST)
// est **dual-auth** — TenantAuthGuard accepte la clé API PA OU une session ;
// RolesGuard/CsrfGuard s'ajoutent ENSUITE et ne s'appliquent QU'à la
// session (les deux court-circuitent explicitement sur `req.apiKeyId`, cf.
// leurs commentaires de classe respectifs — 1er endpoint de mutation du
// projet à composer TenantAuthGuard avec ces deux guards). La lecture (GET)
// reste TenantAuthGuard seul, sans CSRF (aucune mutation).
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @UseGuards(TenantAuthGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin', 'accountant')
  async capture(
    @CurrentTenant() tenantId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string; created: boolean }> {
    const input = parseBody(captureSchema, body)
    const result = await this.payments.capture(tenantId, input)
    // Idempotence (D5) : capture fraîche -> 201 ; rejeu (invoice, reference)
    // déjà connu -> 200 (aucune écriture, reload seul).
    res.status(result.created ? 201 : 200)
    return result
  }

  @Get()
  @UseGuards(TenantAuthGuard)
  list(
    @CurrentTenant() tenantId: string,
    @Query() query: unknown,
  ): Promise<PaymentRow[]> {
    const { invoiceId } = parseQuery(listQuerySchema, query)
    return this.payments.list(tenantId, invoiceId)
  }
}
