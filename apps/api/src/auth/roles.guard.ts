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
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    // Dual-auth (TenantAuthGuard, Task 5 paiements) : un appel machine (clé
    // API) n'a pas de rôle utilisateur applicatif — bypass explicite,
    // symétrique à CsrfGuard (la clé API porte déjà le tenant ; aucune route
    // existante ne combinait TenantAuthGuard et ce guard avant Task 5, ce
    // bypass ne change donc le comportement d'aucune route actuelle).
    if (req.apiKeyId) return true
    // authUser absent (ex : cookie admin plateforme sur une route tenant) →
    // refusé, jamais confondu avec "rôle autorisé".
    const role = req.authUser?.role
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
