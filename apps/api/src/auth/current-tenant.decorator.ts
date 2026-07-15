import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { TenantRequest } from './api-key.guard.js'

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    // req.tenantId est posé par ApiKeyGuard, SessionGuard OU TenantAuthGuard
    // (les trois guards d'authentification qui résolvent un tenant) — le
    // message ne nomme plus un guard unique (obsolète depuis l'introduction
    // de SessionGuard/TenantAuthGuard, amendement A5).
    if (!req.tenantId) {
      throw new Error(
        'CurrentTenant used without a guard that resolves tenantId (ApiKeyGuard/SessionGuard/TenantAuthGuard)',
      )
    }
    return req.tenantId
  },
)
