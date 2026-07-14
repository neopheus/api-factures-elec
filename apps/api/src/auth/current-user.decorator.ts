import { createParamDecorator, type ExecutionContext } from '@nestjs/common'
import type { AuthenticatedUser, SessionRequest } from './auth.types.js'

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    if (!req.authUser) {
      throw new Error('CurrentUser used without SessionGuard (user session)')
    }
    return req.authUser
  },
)
