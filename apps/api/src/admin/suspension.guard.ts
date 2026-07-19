import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
} from '@nestjs/common'
import type { TenantRequest } from '../auth/api-key.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import { AdminSupervisionRepository } from './admin-supervision.repository.js'

// Garde de suspension opérateur (Task 4, spec §4) — posé APRÈS BillingGuard
// sur les 2 mêmes mutations d'émission (POST /invoices, POST
// /ereporting/retransmissions). Lit `tenants.suspended_at` par PK
// (AdminSupervisionRepository.isSuspended, même coût que
// `BillingRepository.getState`).
//
// Contraste DÉLIBÉRÉ avec `BillingGuard` (billing/billing.guard.ts) : ce
// dernier se neutralise INCONDITIONNELLEMENT en `BILLING_DRIVER=none` (aucun
// moyen de devenir 'active' sans Stripe configuré) et s'assouplit en
// `BILLING_ENFORCEMENT=off` (politique commerciale pas encore activée en
// production) — DEUX échappatoires de configuration qui n'ont AUCUN
// équivalent ici. La suspension est une décision OPÉRATEUR (abus, impayé
// grave, demande légale...), jamais une politique commerciale à bascule :
// elle s'applique TOUJOURS, quel que soit le driver de facturation ou l'état
// de l'enforcement — il n'existe structurellement aucune variable d'env qui
// permette de la désactiver globalement.
@Injectable()
export class SuspensionGuard implements CanActivate {
  // @Inject() explicite (motif ApiKeyGuard/BillingGuard/TenantAuthGuard) :
  // sans lui, SWC émet pour ce paramètre de type classe un ternaire
  // design:paramtypes (`typeof X !== 'undefined' ? X : Object`) dont la
  // branche "false" n'est atteignable qu'en cas d'import circulaire cassé —
  // structurellement impossible ici, donc jamais couvrable par un test.
  constructor(
    @Inject(AdminSupervisionRepository)
    private readonly supervision: AdminSupervisionRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    const tenantId = req.tenantId
    if (!tenantId) {
      // Oubli de câblage (SuspensionGuard posé sans guard d'authentification
      // en amont, ou dans le mauvais ordre) : ne JAMAIS dégrader en 403
      // conservateur — cela bloquerait silencieusement un bug de routage
      // plutôt que de le faire hurler. Même posture fail-loud que
      // BillingGuard : un 500 non maîtrisé (capté par ProblemDetailsFilter)
      // plutôt qu'une erreur avalée.
      throw new Error(
        "SuspensionGuard exige un guard d'authentification en amont (req.tenantId absent)",
      )
    }

    const suspended = await this.supervision.isSuspended(tenantId)
    if (suspended) {
      throw new HttpException(
        problem(403, ProblemType.tenantSuspended, 'Tenant suspended'),
        403,
      )
    }
    return true
  }
}
