import {
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import { ProblemType, problem } from '../common/problem.js'
import type { EnvConfig } from '../config/env.js'
import { tenants, users } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import {
  BILLING_PORT,
  type BillingCustomerMeta,
  BillingDisabledError,
  type BillingPort,
  type BillingSubscriptionStatus,
} from './billing.port.js'
// biome-ignore lint/style/useImportType: BillingRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { BillingRepository } from './billing.repository.js'

export interface BillingStatusResult {
  status: BillingSubscriptionStatus
  currentPeriodEnd: string | null
  hasCustomer: boolean
}

// Orchestration checkout/portal/status (Task 6, plan phase 5) — le service
// ne connaît QUE le port (interface stable) et le repository (miroir CAS,
// Task 5) : jamais le SDK Stripe directement (câblé par BillingPortModule).
//
// Invariant D (brief Task 6) : `status()` lit UNIQUEMENT le miroir
// (`BillingRepository.getState`, jamais `this.port`) — vrai même en driver
// 'none' (`GET /billing/status` reste utilisable sans compte Stripe
// configuré). `checkoutSession`/`portalSession`, à l'inverse, appellent
// TOUJOURS le port — une `BillingDisabledError` y est donc attendue et
// traduite en 503 (`ProblemType.billingDisabled`) plutôt que de fuiter en
// 500 non maîtrisé.
@Injectable()
export class BillingService {
  constructor(
    @Inject(BILLING_PORT) private readonly port: BillingPort,
    private readonly repo: BillingRepository,
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  private dashboardUrl(): string {
    return this.config.get('BILLING_DASHBOARD_URL', { infer: true })
  }

  // Lit nom/SIREN du tenant + email de l'utilisateur de session, sous
  // contexte tenant (RLS) — un seul aller-retour `tenant.run`. Aucun service
  // dédié n'existe pour l'un ou l'autre (grep vérifié) : requête directe,
  // motif `UsersService.me` (RLS garantit l'appartenance, la session
  // garantit l'existence — pas de garde défensive supplémentaire ici).
  // `siren` est nullable en base (signup sans SIREN) : replié en chaîne vide
  // plutôt que `null`, `BillingCustomerMeta.siren` étant un `string` non
  // optionnel côté port.
  private async resolveCustomerMeta(
    tenantId: string,
    userId: string,
  ): Promise<BillingCustomerMeta> {
    return this.tenantContext.run(tenantId, async (db) => {
      const [tenantRow] = await db
        .select({ name: tenants.name, siren: tenants.siren })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
      const [userRow] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return {
        tenantId,
        name: tenantRow?.name ?? '',
        siren: tenantRow?.siren ?? '',
        email: userRow?.email ?? '',
      }
    })
  }

  // Réutilise le customer déjà attaché (miroir) s'il existe ; sinon
  // `ensureCustomer` (idempotent côté driver) puis `attachCustomer` (miroir,
  // écrit AVANT la session de checkout — cohérent avec le webhook qui peut
  // arriver avant la réponse HTTP).
  async checkoutSession(
    tenantId: string,
    userId: string,
  ): Promise<{ url: string }> {
    try {
      const state = await this.repo.getState(tenantId)
      let customerId = state.stripeCustomerId
      if (!customerId) {
        const meta = await this.resolveCustomerMeta(tenantId, userId)
        customerId = await this.port.ensureCustomer(meta)
        await this.repo.attachCustomer(tenantId, customerId)
      }
      const base = this.dashboardUrl()
      const url = await this.port.createCheckoutSession(
        customerId,
        `${base}/billing?checkout=success`,
        `${base}/billing?checkout=cancel`,
      )
      return { url }
    } catch (err) {
      throw this.translateDisabled(err)
    }
  }

  // Sans customer (jamais passé par checkout) : 409 explicite — le portail
  // Stripe n'a rien à gérer pour ce tenant, jamais un 503/500 déguisé.
  async portalSession(tenantId: string): Promise<{ url: string }> {
    const state = await this.repo.getState(tenantId)
    if (!state.stripeCustomerId) {
      throw new ConflictException(
        problem(409, ProblemType.conflict, 'No active subscription', {
          detail:
            'tenant has no Stripe customer yet — use the checkout endpoint first',
        }),
      )
    }
    try {
      const url = await this.port.createPortalSession(
        state.stripeCustomerId,
        `${this.dashboardUrl()}/billing`,
      )
      return { url }
    } catch (err) {
      throw this.translateDisabled(err)
    }
  }

  // Miroir SEUL (`BillingRepository.getState`) — jamais `this.port` : reste
  // utilisable même en `BILLING_DRIVER=none` (brief Task 6).
  async status(tenantId: string): Promise<BillingStatusResult> {
    const state = await this.repo.getState(tenantId)
    return {
      status: state.status,
      currentPeriodEnd: state.currentPeriodEnd
        ? state.currentPeriodEnd.toISOString()
        : null,
      hasCustomer: state.stripeCustomerId !== null,
    }
  }

  private translateDisabled(err: unknown): unknown {
    if (err instanceof BillingDisabledError) {
      return new ServiceUnavailableException(
        problem(503, ProblemType.billingDisabled, 'Billing disabled', {
          detail: err.message,
        }),
      )
    }
    return err
  }
}
