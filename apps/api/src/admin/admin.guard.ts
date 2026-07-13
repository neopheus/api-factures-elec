import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import type { SessionRequest } from '../auth/auth.types.js'
import { ProblemType, problem } from '../common/problem.js'

// À placer APRÈS SessionGuard : exige une session de type admin
// (req.authAdmin posé par SessionGuard, cf. auth/session.guard.ts).
// list_tenants_for_admin() (SD, task 2) ne fait AUCUNE vérification interne —
// c'est ce guard, seul, qui restreint /admin/* aux sessions plateforme.
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    if (!req.authAdmin) {
      throw new ForbiddenException(
        problem(403, ProblemType.forbidden, 'Forbidden', {
          detail: 'Super admin only',
        }),
      )
    }
    return true
  }
}
