import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { AuthenticatedAdmin, SessionRequest } from './auth.types.js'

// Symétrique de `CurrentUser` (current-user.decorator.ts) — Task 4 (spec §3)
// introduit le 1er consommateur : AdminController.suspendTenant/
// unsuspendTenant, qui journalisent `admin_actions.admin_id`. Fail-loud
// (motif CurrentUser/CurrentTenant) : req.authAdmin absent = AdminGuard
// omis en amont, un bug de câblage à faire hurler plutôt qu'à masquer par un
// adminId undefined silencieusement écrit en base.
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    if (!req.authAdmin) {
      throw new Error('CurrentAdmin used without AdminGuard (admin session)')
    }
    return req.authAdmin
  },
)
