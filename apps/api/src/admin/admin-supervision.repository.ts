import { Inject, Injectable } from '@nestjs/common'
import { desc, eq } from 'drizzle-orm'
import type pg from 'pg'
import type { BillingSubscriptionStatus } from '../billing/billing.port.js'
import { APP_POOL } from '../db/client.js'
import { invoices, tenantBilling } from '../db/schema.js'
// biome-ignore lint/style/useImportType: TenantContextService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TenantContextService } from '../db/tenant-context.service.js'
import type { LifecycleStatus } from '../invoices/lifecycle-status.js'

// Ligne de la liste enrichie (Task 3, spec §3) — SD 1 find_admin_tenant_stats
// (migration 0031). `id` (pas `tenantId`) : convention héritée de l'ancien
// `TenantOverview` ET contrat HTTP explicite de la spec (`{ tenants: [{ id,
// name, ... }] }`) — aucune raison d'introduire une divergence de nommage
// entre le DTO repository et la réponse JSON, ce module n'a aucun autre
// consommateur.
export interface AdminTenantStats {
  id: string
  name: string
  siren: string | null
  createdAt: Date
  suspendedAt: Date | null
  billingStatus: BillingSubscriptionStatus
  invoices30d: number
  ereporting30d: number
  deadLetters: number
}

// Projection stricte (spec §3) : id/number/lifecycleStatus/createdAt
// SEULEMENT — jamais de montant, jamais le payload canonique (colonne
// lourde, hors scope supervision).
export interface AdminTenantInvoiceSummary {
  id: string
  number: string
  lifecycleStatus: LifecycleStatus
  createdAt: Date
}

// Miroir billing anti-fuite (spec §3) : `hasCustomer` remplace l'id Stripe
// brut (stripeCustomerId) — JAMAIS renvoyé, même à l'admin plateforme (même
// discipline que BillingService.status côté tenant, cf. billing.service.ts).
export interface AdminTenantBillingMirror {
  status: BillingSubscriptionStatus
  currentPeriodEnd: Date | null
  hasCustomer: boolean
}

export interface AdminTenantDetail extends AdminTenantStats {
  invoices: AdminTenantInvoiceSummary[]
  billing: AdminTenantBillingMirror
}

const LAST_INVOICES_LIMIT = 10

interface AdminTenantStatsRow {
  tenant_id: string
  name: string
  siren: string | null
  created_at: Date
  suspended_at: Date | null
  billing_status: string
  invoices_30d: string | number
  ereporting_30d: string | number
  dead_letters: string | number
}

function mapStatsRow(row: AdminTenantStatsRow): AdminTenantStats {
  return {
    id: row.tenant_id,
    name: row.name,
    siren: row.siren,
    createdAt: row.created_at,
    suspendedAt: row.suspended_at,
    billingStatus: row.billing_status as BillingSubscriptionStatus,
    // bigint SQL → number : les 3 agrégats de find_admin_tenant_stats sont
    // déclarés `bigint` côté SD (migration 0031) ; `pg` les renvoie en
    // string faute de type parser dédié (pas de setTypeParser dans ce
    // projet, cf. AdminService.listTenants historique — même conversion).
    invoices30d: Number(row.invoices_30d),
    ereporting30d: Number(row.ereporting_30d),
    deadLetters: Number(row.dead_letters),
  }
}

// Repository de supervision cross-tenant (Task 3, spec §3) — bipartition
// même motif que BillingRepository : `tenantStats`/`tenantDetail` (partie
// stats) s'exécutent HORS tenant.run, directement sur le pool applicatif
// (SD 1 SECURITY DEFINER, structurellement read-only, cross-tenant par
// nature — aucun tenant.run possible ici, c'est l'énumération elle-même).
// La partie détail per-tenant de `tenantDetail` (factures + miroir billing)
// bascule elle sur `tenant.run` (RLS FORCE) — motif : ne jamais lire des
// tables tenant-scopées (invoices, tenant_billing) hors RLS même depuis
// l'admin, la SD ne couvre QUE l'agrégat borné qu'elle projette.
@Injectable()
export class AdminSupervisionRepository {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly tenant: TenantContextService,
  ) {}

  // SD 1 (migration 0031) : find_admin_tenant_stats ne garantit AUCUN ordre
  // (pas de ORDER BY interne, cf. commentaire migration) — le tri
  // created_at DESC (spec §3, « le plus récent d'abord ») est donc posé ici,
  // côté SQL, sur le résultat de la fonction table.
  async tenantStats(): Promise<AdminTenantStats[]> {
    const { rows } = await this.pool.query<AdminTenantStatsRow>(
      'SELECT * FROM find_admin_tenant_stats() ORDER BY created_at DESC',
    )
    return rows.map(mapStatsRow)
  }

  // Requête ciblée (WHERE tenant_id = $1) plutôt que tenantStats().find(...)
  // en mémoire : évite de charger l'intégralité de la liste cross-tenant
  // pour résoudre un seul id. 0 ligne = tenant inconnu → null (404 côté
  // contrôleur, AdminController.tenantDetail).
  async tenantDetail(tenantId: string): Promise<AdminTenantDetail | null> {
    const { rows } = await this.pool.query<AdminTenantStatsRow>(
      'SELECT * FROM find_admin_tenant_stats() WHERE tenant_id = $1',
      [tenantId],
    )
    const row = rows[0]
    if (!row) return null
    const stats = mapStatsRow(row)

    // Lecture per-tenant RLS-scopée (spec §3) : 10 dernières factures
    // (projection stricte, sans montant) + état du miroir billing
    // (tenant_billing). Aucun filtre `eq(invoices.tenantId, tenantId)`
    // explicite sur les factures : RLS FORCE seule fait foi à l'intérieur de
    // `tenant.run` — même convention que InvoicesRepository.list (motif :
    // une régression de la policy RLS doit se voir aux tests RLS eux-mêmes,
    // pas être masquée par un filtre applicatif redondant). Le miroir
    // billing garde lui un `.where(eq(...))` explicite (PK lookup) — même
    // convention que BillingRepository.getState.
    const detail = await this.tenant.run(tenantId, async (db) => {
      const invoiceRows = await db
        .select({
          id: invoices.id,
          number: invoices.number,
          lifecycleStatus: invoices.lifecycleStatus,
          createdAt: invoices.createdAt,
        })
        .from(invoices)
        .orderBy(desc(invoices.createdAt), desc(invoices.id))
        .limit(LAST_INVOICES_LIMIT)

      const billingRows = await db
        .select({
          status: tenantBilling.status,
          currentPeriodEnd: tenantBilling.currentPeriodEnd,
          stripeCustomerId: tenantBilling.stripeCustomerId,
        })
        .from(tenantBilling)
        .where(eq(tenantBilling.tenantId, tenantId))
        .limit(1)
      const billingRow = billingRows[0]

      return {
        invoices: invoiceRows as AdminTenantInvoiceSummary[],
        billing: {
          status: (billingRow?.status ?? 'none') as BillingSubscriptionStatus,
          currentPeriodEnd: billingRow?.currentPeriodEnd ?? null,
          // hasCustomer, jamais l'id brut (spec §3, anti-fuite).
          hasCustomer: billingRow?.stripeCustomerId != null,
        },
      }
    })

    return { ...stats, ...detail }
  }
}
