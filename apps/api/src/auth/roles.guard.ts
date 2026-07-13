import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ProblemType, problem } from '../common/problem.js'
import type { SessionRequest, UserRole } from './auth.types.js'

export const ROLES_KEY = 'factelec:roles'
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles)

@Injectable()
export class RolesGuard implements CanActivate {
  // @Inject(Reflector) explicite : même raison qu'ApiKeyGuard/SessionGuard
  // (auth/api-key.guard.ts, auth/session.guard.ts) — sans lui, SWC émet un
  // ternaire design:paramtypes dont la branche "false" n'est jamais
  // atteignable (donc jamais couvrable).
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    )
    if (!required || required.length === 0) return true
    // authUser absent (ex : cookie admin plateforme sur une route tenant) →
    // refusé, jamais confondu avec "rôle autorisé".
    const role = ctx.switchToHttp().getRequest<SessionRequest>().authUser?.role
    if (!role || !required.includes(role)) {
      throw new ForbiddenException(
        problem(403, ProblemType.forbidden, 'Forbidden', {
          detail: 'Insufficient role',
        }),
      )
    }
    return true
  }
}
