import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import { bindRequestLog } from '../logging/request-log.js'
import type { SessionRequest } from './auth.types.js'
import { SessionService } from './session.service.js'
import { SESSION_COOKIE } from './session-token.js'

@Injectable()
export class SessionGuard implements CanActivate {
  // @Inject(SessionService) explicite : même raison qu'ApiKeyGuard
  // (auth/api-key.guard.ts) — sans lui, SWC émet un ternaire design:paramtypes
  // dont la branche "false" n'est jamais atteignable (donc jamais couvrable).
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    const token = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ]
    const deny = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', {
          detail: 'No active session',
        }),
      )
    if (!token) throw deny()
    const subject = await this.sessions.find(token)
    if (!subject) throw deny()
    if (subject.userId && subject.tenantId) {
      req.authUser = {
        sessionId: subject.sessionId,
        userId: subject.userId,
        tenantId: subject.tenantId,
        role: subject.role ?? 'viewer',
        csrfHash: subject.csrfHash,
      }
      req.tenantId = subject.tenantId
      // Corrélation logs (Task 9, spec §6) : session UTILISATEUR → tenantId.
      // Le binding adminId d'une session admin est posé par AdminGuard (placé
      // après ce garde sur /admin/*), pas ici — cf. request-log.ts.
      bindRequestLog(req, { tenantId: subject.tenantId })
      return true
    }
    if (subject.adminId) {
      req.authAdmin = {
        sessionId: subject.sessionId,
        adminId: subject.adminId,
        csrfHash: subject.csrfHash,
      }
      return true
    }
    throw deny()
  }
}
