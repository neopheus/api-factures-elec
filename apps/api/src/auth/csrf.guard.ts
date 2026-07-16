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
    // Dual-auth (TenantAuthGuard, Task 5 paiements — 1er endpoint de
    // mutation à composer TenantAuthGuard avec ce guard) : un appel machine
    // (clé API) n'a ni cookie ni `authUser`/`authAdmin` — bypass explicite,
    // conforme au commentaire de classe ci-dessus. Sans ce garde, empiler ce
    // guard après TenantAuthGuard rejetterait TOUJOURS les requêtes machine
    // en 403 (aucune route existante ne combinait encore les deux avant
    // Task 5 — vérifié, ce bypass ne change le comportement d'AUCUNE route
    // actuelle, apiKeyId n'y est jamais posé en amont de ce guard).
    if (req.apiKeyId) return true
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
