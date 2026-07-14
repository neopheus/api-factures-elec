import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import { ApiKeyService } from './api-key.service.js'
import type { SessionRequest } from './auth.types.js'
import { SessionService } from './session.service.js'
import { SESSION_COOKIE } from './session-token.js'

const BEARER_RE = /^Bearer\s+(.+)$/i

// Lecture tenant : clé API (machine) OU session utilisateur (dashboard). Admin refusé.
// Précédence : un `Authorization: Bearer` présent est TOUJOURS résolu en priorité
// (même invalide) — un client machine qui envoie une clé expirée/révoquée ne doit
// jamais retomber silencieusement sur un cookie de session qui traînerait dans la
// même requête ; la clé est l'intention explicite, elle est authoritative.
@Injectable()
export class TenantAuthGuard implements CanActivate {
  // @Inject() explicite sur les deux dépendances : même raison qu'ApiKeyGuard/
  // SessionGuard (auth/api-key.guard.ts, auth/session.guard.ts) — sans lui, SWC
  // émet un ternaire design:paramtypes dont la branche "false" n'est jamais
  // atteignable (donc jamais couvrable par la coverage v8).
  constructor(
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    const deny = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', {
          detail: 'Missing or invalid credentials',
        }),
      )

    const bearer = req.header('authorization')?.match(BEARER_RE)
    if (bearer?.[1]) {
      const key = await this.apiKeys.authenticate(bearer[1])
      if (!key) throw deny()
      req.tenantId = key.tenantId
      req.apiKeyId = key.apiKeyId
      return true
    }

    const token = (req.cookies as Record<string, string> | undefined)?.[
      SESSION_COOKIE
    ]
    if (token) {
      const subject = await this.sessions.find(token)
      if (subject?.userId && subject.tenantId) {
        req.authUser = {
          sessionId: subject.sessionId,
          userId: subject.userId,
          tenantId: subject.tenantId,
          role: subject.role ?? 'viewer',
          csrfHash: subject.csrfHash,
        }
        req.tenantId = subject.tenantId
        return true
      }
    }
    throw deny()
  }
}
