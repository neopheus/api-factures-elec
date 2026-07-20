import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Counter } from 'prom-client'
import type { TenantRequest } from '../auth/api-key.guard.js'
import { ProblemType, problem } from '../common/problem.js'
import type { EnvConfig } from '../config/env.js'
import { MetricsService } from '../metrics/metrics.service.js'
import type { BillingSubscriptionStatus } from './billing.port.js'
import { BillingRepository } from './billing.repository.js'

// Statuts qui laissent passer la requête (spec §4, mêmes valeurs que le
// contrat BillingSubscriptionStatus) : abonnement actif ou en essai, ou
// retard de paiement encore toléré par Stripe (`past_due` — Stripe retente le
// prélèvement pendant une fenêtre avant de faire passer l'abonnement à
// `unpaid`/`canceled`) ; couper l'accès dès le premier échec de paiement
// serait plus punitif que la politique de rétention Stripe elle-même.
const ALLOWED_STATUSES: ReadonlySet<BillingSubscriptionStatus> = new Set([
  'active',
  'trialing',
  'past_due',
])

// Garde d'enforcement (Task 8, plan phase 5, spec Stripe 2026-07-19) —
// bloque en 402 les mutations d'ÉMISSION (dépôt facture, retransmission
// e-reporting) tant que le tenant n'a pas d'abonnement valide. Config lue au
// CONSTRUCTEUR (motif SessionPurgeScheduler) : driver/enforcement sont figés
// au démarrage du process, jamais réévalués par requête — cohérent avec le
// reste de la config env (un changement de politique exige un redéploiement,
// pas un hot-reload en cours de service).
@Injectable()
export class BillingGuard implements CanActivate {
  private readonly logger = new Logger(BillingGuard.name)
  private readonly driver: EnvConfig['BILLING_DRIVER']
  private readonly enforcement: EnvConfig['BILLING_ENFORCEMENT']
  // Compteur d'observabilité (Task 9, spec §6) — `undefined` si sa création
  // échoue (nom déjà enregistré sur ce registre : structurellement
  // impossible en usage normal, un seul BillingGuard par process, mais ne
  // doit JAMAIS rendre le garde lui-même inopérant). Créé UNE FOIS au
  // constructeur, jamais recréé par requête : `.inc()` au point d'usage est
  // alors une opération prom-client sans label, qui ne peut plus throw.
  private readonly denialCounter: Counter | undefined

  // @Inject() explicite sur les dépendances (motif ApiKeyGuard/
  // TenantAuthGuard, auth/api-key.guard.ts, auth/tenant-auth.guard.ts) :
  // sans lui, SWC émet pour chaque paramètre de type classe un ternaire
  // design:paramtypes (`typeof X !== 'undefined' ? X : Object`) dont la
  // branche "false" n'est atteignable qu'en cas d'import circulaire cassé —
  // structurellement impossible ici, donc jamais couvrable par un test.
  constructor(
    @Inject(BillingRepository) private readonly billing: BillingRepository,
    @Inject(ConfigService) config: ConfigService<EnvConfig, true>,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    this.driver = config.get('BILLING_DRIVER', { infer: true })
    this.enforcement = config.get('BILLING_ENFORCEMENT', { infer: true })
    try {
      this.denialCounter = new Counter({
        name: 'billing_guard_denials_total',
        help: 'Nombre de requêtes bloquées par BillingGuard (402, enforcement on)',
        registers: [metrics.registry],
      })
    } catch (err) {
      this.logger.warn(
        `compteur billing_guard_denials_total indisponible, garde non affecté : ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // driver='none' neutralise INCONDITIONNELLEMENT le garde (spec §4) —
    // MÊME si BILLING_ENFORCEMENT='on' : sans driver Stripe configuré, aucun
    // tenant ne peut jamais devenir 'active' (aucun checkout possible), donc
    // bloquer reviendrait à couper toute la plateforme plutôt qu'à faire
    // respecter une politique de facturation.
    if (this.driver === 'none') return true

    const req = ctx.switchToHttp().getRequest<TenantRequest>()
    const tenantId = req.tenantId
    if (!tenantId) {
      // Oubli de câblage (BillingGuard posé sans guard d'authentification en
      // amont, ou dans le mauvais ordre) : ne JAMAIS dégrader en 402
      // conservateur — cela facturerait/bloquerait silencieusement un bug de
      // routage. On fait hurler l'erreur en 500 non maîtrisé (capté par
      // ProblemDetailsFilter) plutôt que de l'avaler.
      throw new Error(
        "BillingGuard exige un guard d'authentification en amont (req.tenantId absent)",
      )
    }

    const { status } = await this.billing.getState(tenantId)
    if (ALLOWED_STATUSES.has(status)) return true

    if (this.enforcement === 'off') {
      // Enforcement désactivé (avant le go-live commercial) : le garde
      // OBSERVE et laisse passer — le log warn est le seul signal qu'un
      // tenant aurait été bloqué si l'enforcement était activé.
      this.logger.warn(
        `billing enforcement off — tenant=${tenantId} statut=${status} route=${req.method} ${req.originalUrl} laissé passer`,
      )
      return true
    }

    this.denialCounter?.inc()
    throw new HttpException(
      problem(402, ProblemType.paymentRequired, 'Subscription required'),
      402,
    )
  }
}
