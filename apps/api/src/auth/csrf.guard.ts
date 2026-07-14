import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common'
import { ProblemType, problem } from '../common/problem.js'
import type { SessionRequest } from './auth.types.js'
import { CSRF_HEADER, hashToken, safeEqualHex } from './session-token.js'

// Double-submit lié à la session : X-CSRF-Token (valeur du cookie lisible) vs
// hash stocké. S'applique UNIQUEMENT aux mutations authentifiées par session
// (jamais aux chemins machine — ApiKeyGuard/Bearer — qui n'ont pas de cookie).
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<SessionRequest>()
    const csrfHash = req.authUser?.csrfHash ?? req.authAdmin?.csrfHash
    const header = req.header(CSRF_HEADER)
    const deny = () =>
      new ForbiddenException(
        problem(403, ProblemType.forbidden, 'Forbidden', {
          detail: 'Invalid CSRF token',
        }),
      )
    if (!csrfHash || !header) throw deny()
    if (!safeEqualHex(hashToken(header), csrfHash)) throw deny()
    return true
  }
}
