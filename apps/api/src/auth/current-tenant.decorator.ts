import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { TenantRequest } from './api-key.guard.js'

export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    if (!req.tenantId) throw new Error('CurrentTenant used without ApiKeyGuard')
    return req.tenantId
  },
)
