import { Controller, Get, Post, UseGuards } from '@nestjs/common'
import type { AuthenticatedUser } from '../auth/auth.types.js'
import { CsrfGuard } from '../auth/csrf.guard.js'
import { CurrentTenant } from '../auth/current-tenant.decorator.js'
import { CurrentUser } from '../auth/current-user.decorator.js'
import { Roles, RolesGuard } from '../auth/roles.guard.js'
import { SessionGuard } from '../auth/session.guard.js'
// biome-ignore lint/style/useImportType: BillingService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { BillingService } from './billing.service.js'

// Session UNIQUEMENT (owner|admin) : la facturation n'est jamais pilotée par
// une clé API machine (pas de TenantAuthGuard ici, contrairement aux routes
// dual-auth d'InvoicesController/PaymentsController). Les 2 mutations POST
// ajoutent CsrfGuard (motif InvoicesController `:id/status`) ; GET status
// n'en a pas besoin (aucune écriture).
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('checkout-session')
  @UseGuards(SessionGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin')
  checkoutSession(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ url: string }> {
    return this.billing.checkoutSession(tenantId, user.userId)
  }

  @Post('portal-session')
  @UseGuards(SessionGuard, RolesGuard, CsrfGuard)
  @Roles('owner', 'admin')
  portalSession(@CurrentTenant() tenantId: string): Promise<{ url: string }> {
    return this.billing.portalSession(tenantId)
  }

  @Get('status')
  @UseGuards(SessionGuard, RolesGuard)
  @Roles('owner', 'admin')
  status(@CurrentTenant() tenantId: string) {
    return this.billing.status(tenantId)
  }
}
