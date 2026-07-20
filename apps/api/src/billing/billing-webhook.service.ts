import { Inject, Injectable, Logger } from '@nestjs/common'
import { Counter } from 'prom-client'
import { MetricsService } from '../metrics/metrics.service.js'
import {
  BILLING_PORT,
  type BillingPort,
  BillingSignatureError,
  type BillingWebhookEvent,
} from './billing.port.js'
// biome-ignore lint/style/useImportType: BillingRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { BillingRepository } from './billing.repository.js'

export type BillingWebhookFailureReason =
  | 'signature'
  | 'unknown-customer'
  | 'no-status'
  | 'stale'

export interface BillingWebhookResult {
  handled: boolean
  reason?: BillingWebhookFailureReason
}

// Traitement du webhook Stripe (Task 7, plan phase 5) — jamais de guard
// session/CSRF en amont (cf. controller) : cette méthode EST l'authentification
// (signature HMAC vérifiée par le port). Contrat Stripe : répondre 200 pour
// tout événement qu'on choisit délibérément d'ignorer (customer inconnu,
// événement sans statut, événement en retard) — seule une signature invalide
// vaut un rejet (400, traduit par le controller). Ne throw JAMAIS en dehors
// de la resignalisation d'une erreur inattendue du port : le contrôleur ne
// sait traduire que `BillingSignatureError` en 400, tout le reste doit
// remonter tel quel (500 via le filtre global) plutôt que d'être avalé ici.
@Injectable()
export class BillingWebhookService {
  private readonly logger = new Logger(BillingWebhookService.name)
  // Compteur d'observabilité (Task 9, spec §6) — `undefined` si sa création
  // échoue (motif BillingGuard.denialCounter) : ne doit JAMAIS rendre le
  // traitement du webhook Stripe inopérant pour une raison d'observabilité.
  private readonly eventsCounter: Counter<'outcome'> | undefined

  constructor(
    @Inject(BILLING_PORT) private readonly port: BillingPort,
    private readonly repo: BillingRepository,
    @Inject(MetricsService) metrics: MetricsService,
  ) {
    try {
      this.eventsCounter = new Counter({
        name: 'billing_webhook_events_total',
        help: 'Nombre d’événements webhook Stripe traités, par issue',
        labelNames: ['outcome'],
        registers: [metrics.registry],
      })
    } catch (err) {
      this.logger.warn(
        `compteur billing_webhook_events_total indisponible, traitement non affecté : ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  private record(outcome: BillingWebhookFailureReason | 'handled'): void {
    this.eventsCounter?.inc({ outcome })
  }

  async handle(raw: Buffer, signature: string): Promise<BillingWebhookResult> {
    let evt: BillingWebhookEvent
    try {
      evt = this.port.constructWebhookEvent(raw, signature)
    } catch (err) {
      if (err instanceof BillingSignatureError) {
        this.record('signature')
        return { handled: false, reason: 'signature' }
      }
      throw err
    }

    if (evt.customerId === null) {
      this.logger.warn('billing webhook: événement sans customerId — ignoré')
      this.record('unknown-customer')
      return { handled: false, reason: 'unknown-customer' }
    }

    const tenantId = await this.repo.findTenantByCustomer(evt.customerId)
    if (tenantId === null) {
      this.logger.warn(
        `billing webhook: customer Stripe inconnu (${evt.customerId}) — événement ignoré`,
      )
      this.record('unknown-customer')
      return { handled: false, reason: 'unknown-customer' }
    }

    // Événement sans statut (ex. objets Stripe hors abonnement) : ignoré
    // délibérément, `applyEvent` ne doit JAMAIS être appelé avec un statut
    // null (garde défensive dupliquée côté BillingRepository.applyEvent).
    if (evt.status === null) {
      this.record('no-status')
      return { handled: false, reason: 'no-status' }
    }

    const applied = await this.repo.applyEvent(tenantId, evt)
    if (!applied) {
      // CAS anti-réordonnancement côté repository a rejeté l'événement
      // (plus ancien que le dernier appliqué) : idempotence côté émetteur,
      // 200 quand même — Stripe ne doit jamais retenter indéfiniment un
      // événement qu'on a déjà vu passer.
      this.record('stale')
      return { handled: false, reason: 'stale' }
    }
    this.record('handled')
    return { handled: true }
  }
}
