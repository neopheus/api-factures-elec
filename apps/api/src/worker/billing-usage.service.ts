import { Inject, Injectable, Logger } from '@nestjs/common'
import { and, count, gte, lt } from 'drizzle-orm'
import {
  BILLING_PORT,
  type BillingPort,
  type BillingUsageEvent,
} from '../billing/billing.port.js'
// biome-ignore lint/style/useImportType: BillingRepository résolu par Nest via design:paramtypes.
import { BillingRepository } from '../billing/billing.repository.js'
import { ereportingTransmissions, invoices } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService résolu par Nest via design:paramtypes.
import { TenantContextService } from '../db/tenant-context.service.js'

// Sweep quotidien de report d'usage billing (Task 9, phase 5 Stripe). Pour
// CHAQUE tenant abonné (`listSubscribedTenants`, SD cross-tenant migration
// 0030) : compte les documents (factures + transmissions e-reporting) créés
// la VEILLE (UTC) — `recordUsage` (idempotent tenant×jour, ON CONFLICT DO
// NOTHING côté repository) — puis reporte au driver Stripe TOUTES les lignes
// encore non reportées (`findUnreportedUsage`, pas seulement celle du jour :
// un backlog issu d'un run précédent en échec est rattrapé ici) — enfin
// `markUsageReported` par ligne. Isolation d'erreur PAR TENANT (try/catch
// autour du traitement complet d'un tenant, motif
// RecipientRoutingRetryService) : un échec Stripe sur le tenant A ne prive
// jamais le tenant B — et surtout, un échec de `reportUsage` laisse les
// lignes NON marquées (reprise naturelle au run suivant, jamais de perte
// d'usage facturable).
@Injectable()
export class BillingUsageService {
  private readonly logger = new Logger(BillingUsageService.name)

  constructor(
    private readonly billing: BillingRepository,
    private readonly tenant: TenantContextService,
    @Inject(BILLING_PORT) private readonly port: BillingPort,
  ) {}

  async sweep(): Promise<{ tenants: number; reported: number }> {
    // Jour cible = veille UTC (le sweep tourne en cours de journée J, les
    // documents de J ne sont pas encore définitivement comptabilisables).
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - 1)
    const day = d.toISOString().slice(0, 10)

    const subscribed = await this.billing.listSubscribedTenants()
    let reported = 0
    for (const { tenantId, stripeCustomerId } of subscribed) {
      try {
        const n = await this.countDocuments(tenantId, day)
        await this.billing.recordUsage(tenantId, day, n)

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
