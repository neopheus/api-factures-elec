import { Inject, Injectable, Logger } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService résolu par Nest via design:paramtypes.
import { ConfigService } from '@nestjs/config'
import { and, count, gte, lt } from 'drizzle-orm'
import {
  BILLING_PORT,
  type BillingPort,
  type BillingUsageEvent,
} from '../billing/billing.port.js'
// biome-ignore lint/style/useImportType: BillingRepository résolu par Nest via design:paramtypes.
import { BillingRepository } from '../billing/billing.repository.js'
import type { EnvConfig } from '../config/env.js'
import { ereportingTransmissions, invoices } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService résolu par Nest via design:paramtypes.
import { TenantContextService } from '../db/tenant-context.service.js'

// Sweep quotidien de report d'usage billing (Task 9, phase 5 Stripe — fenêtre
// de rattrapage I2, revue finale). Pour CHAQUE tenant abonné
// (`listSubscribedTenants`, SD cross-tenant migration 0030) : pour CHAQUE
// jour de la fenêtre [J-N, J-1] UTC (N = `BILLING_USAGE_LOOKBACK_DAYS`,
// défaut 3, balayée du plus ANCIEN au plus récent — motif
// CdvTransmissionSweepService/CDV_TRANSMISSION_LOOKBACK_MS) — compte les
// documents (factures + transmissions e-reporting) créés ce jour-là puis
// `recordUsage` (idempotent tenant×jour, ON CONFLICT DO NOTHING côté
// repository : rejouer un jour déjà enregistré est un no-op, jamais une
// double ligne). SANS cette fenêtre, un worker down >24h qui franchit une
// frontière de jour UTC perdrait DÉFINITIVEMENT l'usage du jour non balayé
// (le sweep suivant ne recalcule que J-1) — sous-facturation silencieuse
// (revue finale I2). `findUnreportedUsage` reste appelé UNE SEULE fois par
// tenant, APRÈS la boucle de jours : il rattrape déjà tout le non-reporté,
// tous jours confondus (pas seulement ceux de cette fenêtre) — puis reporte
// au driver Stripe TOUTES ces lignes, enfin `markUsageReported` par ligne.
// Chemin mark-échoué sûr même en cas de rejeu d'un jour déjà reporté avec
// succès côté Stripe mais pas encore marqué localement (crash entre
// `reportUsage` et `markUsageReported`) : `StripeBillingDriver.reportUsage`
// construit un identifiant déterministe `${customerId}-${day}` par meter
// event — Stripe déduplique lui-même sur cette clé, un second appel pour le
// même (customer, jour) est un no-op côté facturation, jamais un double
// comptage. Isolation d'erreur PAR TENANT (try/catch autour du traitement
// complet d'un tenant, motif RecipientRoutingRetryService) : un échec Stripe
// sur le tenant A ne prive jamais le tenant B — et surtout, un échec de
// `reportUsage` laisse les lignes NON marquées (reprise naturelle au run
// suivant, jamais de perte d'usage facturable).
@Injectable()
export class BillingUsageService {
  private readonly logger = new Logger(BillingUsageService.name)
  private readonly lookbackDays: number

  constructor(
    private readonly billing: BillingRepository,
    private readonly tenant: TenantContextService,
    @Inject(BILLING_PORT) private readonly port: BillingPort,
    config: ConfigService<EnvConfig, true>,
  ) {
    this.lookbackDays = config.get('BILLING_USAGE_LOOKBACK_DAYS', {
      infer: true,
    })
  }

  async sweep(): Promise<{ tenants: number; reported: number }> {
    const days = this.targetDays(new Date())

    const subscribed = await this.billing.listSubscribedTenants()
    let reported = 0
    for (const { tenantId, stripeCustomerId } of subscribed) {
      try {
        for (const day of days) {
          const n = await this.countDocuments(tenantId, day)
          await this.billing.recordUsage(tenantId, day, n)
        }

        const unreported = await this.billing.findUnreportedUsage(tenantId)
        if (unreported.length === 0) continue

        const events: BillingUsageEvent[] = unreported.map((u) => ({
          customerId: stripeCustomerId,
          day: u.day,
          count: u.count,
        }))
        await this.port.reportUsage(events)

        // markUsageReported APRÈS un reportUsage réussi seulement — si
        // reportUsage ci-dessus a levé, le catch ci-dessous intercepte avant
        // d'atteindre cette boucle : aucune ligne n'est marquée, le run
        // suivant les retrouvera via findUnreportedUsage (pas de perte).
        for (const u of unreported) {
          await this.billing.markUsageReported(tenantId, u.id)
          reported++
        }
      } catch (err) {
        this.logger.error(
          `billing usage sweep failed for tenant ${tenantId}`,
          err as Error,
        )
      }
    }
    if (subscribed.length > 0) {
      this.logger.log(
        `billing usage sweep: ${subscribed.length} tenant(s), ${reported} usage line(s) reported`,
      )
    }
    return { tenants: subscribed.length, reported }
  }

  // Fenêtre [J-N, J-1] (UTC), triée du plus ANCIEN au plus récent (I2). J lui
  // -même n'est JAMAIS inclus : le sweep tourne en cours de journée J, ses
  // documents ne sont pas encore définitivement comptabilisables.
  private targetDays(now: Date): string[] {
    const days: string[] = []
    for (let offset = this.lookbackDays; offset >= 1; offset--) {
      const d = new Date(now)
      d.setUTCDate(d.getUTCDate() - offset)
      days.push(d.toISOString().slice(0, 10))
    }
    return days
  }

  // documents traités du jour J (UTC) : factures ingérées + transmissions
  // e-reporting créées. Compte RLS-scopé (tenant.run) — le SD ne sert qu'à
  // énumérer les tenants abonnés.
  private async countDocuments(tenantId: string, day: string): Promise<number> {
    const from = new Date(`${day}T00:00:00.000Z`)
    const to = new Date(`${day}T24:00:00.000Z`)
    return this.tenant.run(tenantId, async (db) => {
      const [inv] = await db
        .select({ n: count() })
        .from(invoices)
        .where(and(gte(invoices.createdAt, from), lt(invoices.createdAt, to)))
      const [ere] = await db
        .select({ n: count() })
        .from(ereportingTransmissions)
        .where(
          and(
            gte(ereportingTransmissions.createdAt, from),
            lt(ereportingTransmissions.createdAt, to),
          ),
        )
      return Number(inv?.n ?? 0) + Number(ere?.n ?? 0)
    })
  }
}
