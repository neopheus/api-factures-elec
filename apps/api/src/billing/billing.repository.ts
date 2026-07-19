import { Inject, Injectable } from '@nestjs/common'
import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
import { billingUsageReports, tenantBilling } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type {
  BillingSubscriptionStatus,
  BillingWebhookEvent,
} from './billing.port.js'

export interface TenantBillingState {
  status: BillingSubscriptionStatus
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  currentPeriodEnd: Date | null
}

const NONE_STATE: TenantBillingState = {
  status: 'none',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  currentPeriodEnd: null,
}

// Miroir CAS anti-réordonnancement (spec §4) + report d'usage idempotent
// (spec §6). Même bipartition que les autres repositories worker (ex.
// InvoicesRepository) : opérations tenant-scopées via `TenantContextService`
// (SET LOCAL app.tenant_id, RLS FORCE) ; les 2 fonctions SD s'exécutent hors
// contexte tenant, directement sur le pool injecté (`APP_POOL`) — dont le
// rôle Postgres réel dépend du MODULE qui fournit cette classe
// (DbModule.forRoot('DATABASE_URL') → factelec_app côté API,
// DbModule.forRoot('DATABASE_URL_WORKER') → factelec_worker côté worker,
// cf. db.module.ts) : ne PAS créer un second mécanisme de connexion, cette
// classe est destinée à être provided dans les DEUX modules, chacun avec son
// propre pool/rôle, exactement comme InvoicesRepository.
@Injectable()
export class BillingRepository {
  constructor(
    private readonly tenant: TenantContextService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
  ) {}

  // Ligne absente = jamais abonné → état 'none' par défaut (pas de ligne à
  // créer en lecture ; le premier écrivain est attachCustomer/applyEvent).
  async getState(tenantId: string): Promise<TenantBillingState> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({
          status: tenantBilling.status,
          stripeCustomerId: tenantBilling.stripeCustomerId,
          stripeSubscriptionId: tenantBilling.stripeSubscriptionId,
          currentPeriodEnd: tenantBilling.currentPeriodEnd,
        })
        .from(tenantBilling)
        .where(eq(tenantBilling.tenantId, tenantId))
        .limit(1)
      return rows[0] ?? NONE_STATE
    })
  }

  // Upsert du mapping (tenant → customer Stripe). Ligne absente → création
  // (statut initial 'none', premier écrivain du miroir). Ligne présente avec
  // le MÊME customer → no-op idempotent (rejeu sûr d'ensureCustomer). Ligne
  // présente avec un customer DIFFÉRENT non-null → throw : deux customers
  // Stripe pour un même tenant est une corruption de mapping qui ne doit
  // JAMAIS être absorbée silencieusement (webhook mal routé / bug amont).
  async attachCustomer(tenantId: string, customerId: string): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      const existing = await db
        .select({ stripeCustomerId: tenantBilling.stripeCustomerId })
        .from(tenantBilling)
        .where(eq(tenantBilling.tenantId, tenantId))
        .limit(1)

      if (existing.length === 0) {
        await db.insert(tenantBilling).values({
          tenantId,
          stripeCustomerId: customerId,
          status: 'none',
        })
        return
      }

      const current = existing[0]?.stripeCustomerId ?? null
      if (current === customerId) return
      if (current !== null) {
        throw new Error(
          `billing: le tenant ${tenantId} est déjà rattaché au customer Stripe ${current} — refus d'écraser avec ${customerId}`,
        )
      }
      // current === null (ligne créée sans customer, ex. par applyEvent) :
      // premier rattachement, pas un écrasement.
      await db
        .update(tenantBilling)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(tenantBilling.tenantId, tenantId))
    })
  }

  // CAS anti-réordonnancement (spec §4, assoupli par l'amendement A1) :
  // l'UPDATE ne s'applique QUE si aucun événement STRICTEMENT plus récent
  // n'a déjà été appliqué (last_event_created NULL, ou <= occurredAt — pas
  // seulement <). L'événement Stripe est l'état COMPLET (pas un patch
  // partiel) : subscriptionId/status écrasent explicitement les valeurs
  // précédentes — SAUF currentPeriodEnd, dont le tri-état
  // (BillingWebhookEvent.currentPeriodEnd) fait l'exception ciblée par
  // l'amendement A1 : `undefined` PRÉSERVE la colonne (omise du SET),
  // `null`/`Date` l'écrasent normalement comme les autres champs.
  //
  // 0 ligne mise à jour est ambigu (ligne absente OU événement en retard) :
  // on tranche par un SELECT — absente → INSERT (première application, y
  // compris le statut initial) ; présente → l'événement est en retard,
  // rejeté (false), aucune écriture.
  async applyEvent(
    tenantId: string,
    evt: BillingWebhookEvent,
  ): Promise<boolean> {
    // Garde défensive : le service ne doit JAMAIS appeler applyEvent avec un
    // événement sans statut (contrat BillingWebhookEvent.status) — si cela
    // arrivait quand même, on rejette plutôt que d'écrire un statut null.
    if (evt.status === null) return false
    const status = evt.status
    // `undefined` = non porté (checkout.session.completed, invoice.*, type
    // non consommé) → clé omise du SET, Drizzle ne l'inclut pas dans le SQL
    // généré, la colonne existante n'est jamais touchée.
    const currentPeriodEndPatch =
      evt.currentPeriodEnd === undefined
        ? {}
        : { currentPeriodEnd: evt.currentPeriodEnd }

    return this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(tenantBilling)
        .set({
          status,
          stripeSubscriptionId: evt.subscriptionId,
          ...currentPeriodEndPatch,
          lastEventCreated: evt.occurredAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(tenantBilling.tenantId, tenantId),
            or(
              isNull(tenantBilling.lastEventCreated),
              // <= (pas <, amendement A1) : les événements de la MÊME
              // seconde que le dernier appliqué s'appliquent aussi. Stripe
              // délivre parfois checkout.session.completed puis
              // customer.subscription.created dans la même seconde
              // (précision event.created à la seconde), et c'est souvent le
              // second qui porte la période — un `<` strict le rejetait à
              // tort. Un événement identique ré-délivré (retry Stripe) se
              // ré-applique sans changement observable : inoffensif.
              lte(tenantBilling.lastEventCreated, evt.occurredAt),
            ),
          ),
        )
        .returning({ tenantId: tenantBilling.tenantId })
      if (updated.length > 0) return true

      const existing = await db
        .select({ tenantId: tenantBilling.tenantId })
        .from(tenantBilling)
        .where(eq(tenantBilling.tenantId, tenantId))
        .limit(1)
      if (existing.length > 0) return false // événement en retard, rejeté

      await db.insert(tenantBilling).values({
        tenantId,
        status,
        stripeSubscriptionId: evt.subscriptionId,
        // Première application : rien à préserver, undefined devient null.
        currentPeriodEnd: evt.currentPeriodEnd ?? null,
        lastEventCreated: evt.occurredAt,
      })
      return true
    })
  }

  // SD 1 (migration 0030) : le webhook Stripe arrive SANS contexte tenant
  // (impossible de poser app.tenant_id avant de savoir QUEL tenant) — cette
  // méthode s'exécute donc directement sur le pool injecté, hors
  // `tenant.run`, structurellement read-only (SECURITY DEFINER, un seul
  // SELECT). `find_billing_tenant_by_customer` retourne NULL (donc une
  // ligne avec tenant_id NULL, pas 0 ligne) si le customer est inconnu.
  async findTenantByCustomer(customerId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ tenant_id: string | null }>(
      'SELECT find_billing_tenant_by_customer($1) AS tenant_id',
      [customerId],
    )
    return rows[0]?.tenant_id ?? null
  }

  // SD 2 (migration 0030) : énumération cross-tenant des tenants abonnés,
  // consommée par le sweep d'usage worker — EXECUTE accordé au seul rôle
  // factelec_worker. Comme `find_stuck_generation_invoices`
  // (InvoiceReconciliationService), directement sur le pool injecté : le
  // rôle Postgres réel dépend du module qui fournit cette instance.
  async listSubscribedTenants(): Promise<
    { tenantId: string; stripeCustomerId: string }[]
  > {
    const { rows } = await this.pool.query<{
      tenant_id: string
      stripe_customer_id: string
    }>('SELECT * FROM find_billing_subscribed_tenants()')
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      stripeCustomerId: r.stripe_customer_id,
    }))
  }

  // Idempotence (tenant, day) portée par la contrainte unique
  // (billing_usage_reports_tenant_day_unique) → ON CONFLICT DO NOTHING : un
  // rejeu du sweep d'usage ne double jamais le comptage d'un jour déjà
  // enregistré.
  async recordUsage(
    tenantId: string,
    day: string,
    count: number,
  ): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db
        .insert(billingUsageReports)
        .values({ tenantId, day, count })
        .onConflictDoNothing({
          target: [billingUsageReports.tenantId, billingUsageReports.day],
        })
    })
  }

  async findUnreportedUsage(
    tenantId: string,
  ): Promise<{ id: string; day: string; count: number }[]> {
    return this.tenant.run(tenantId, async (db) => {
      return db
        .select({
          id: billingUsageReports.id,
          day: billingUsageReports.day,
          count: billingUsageReports.count,
        })
        .from(billingUsageReports)
        .where(
          and(
            eq(billingUsageReports.tenantId, tenantId),
            isNull(billingUsageReports.reportedAt),
          ),
        )
        .orderBy(asc(billingUsageReports.day))
    })
  }

  async markUsageReported(tenantId: string, id: string): Promise<void> {
    await this.tenant.run(tenantId, async (db) => {
      await db
        .update(billingUsageReports)
        .set({ reportedAt: new Date() })
        .where(
          and(
            eq(billingUsageReports.tenantId, tenantId),
            eq(billingUsageReports.id, id),
          ),
        )
    })
  }
}
