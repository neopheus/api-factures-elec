import { Inject, Injectable } from '@nestjs/common'
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import type pg from 'pg'
import type { BillingSubscriptionStatus } from '../billing/billing.port.js'
import { APP_POOL } from '../db/client.js'
import { adminActions, invoices, tenantBilling, tenants } from '../db/schema.js'
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

// Résultats de suspend/unsuspend (Task 4, spec §3/§4) — union discriminée
// plutôt qu'un booléen/exception : le contrôleur mappe chaque `outcome` sur
// le code HTTP exact (404 tenant inconnu, 409 idempotence, 200/204 succès)
// SANS avoir à redevenir de la logique SQL (0 ligne affectée par l'UPDATE
// est ambigu — tenant inconnu OU déjà dans l'état cible — motif
// `BillingRepository.applyEvent`, même CAS avec SELECT de départage).
export type SuspendOutcome =
  | { outcome: 'suspended'; suspendedAt: Date }
  | { outcome: 'already_suspended' }
  | { outcome: 'not_found' }

export type UnsuspendOutcome =
  | { outcome: 'unsuspended' }
  | { outcome: 'not_suspended' }
  | { outcome: 'not_found' }

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

  // Lue par `SuspensionGuard` (Task 4, spec §4) — requête directe indexée
  // par PK, même coût que `BillingRepository.getState`. `tenant.run(tenantId,
  // ...)` est REQUIS ici (pas un simple `pool.query` comme les 2 méthodes
  // ci-dessus) : contrairement aux 2 SD cross-tenant, cette lecture cible LA
  // table `tenants` elle-même, sous RLS FORCE avec la policy `tenant_self`
  // (migration 0001 : `USING (id = current_setting('app.tenant_id'))`) — hors
  // contexte tenant, `factelec_app` ne verrait JAMAIS la ligne (0 résultat
  // silencieux, PAS une erreur), ce qui ferait passer TOUTE requête comme non
  // suspendue. Poser `app.tenant_id = tenantId` (le tenant qu'on interroge)
  // satisfait exactement la policy — aucune fuite cross-tenant possible
  // puisqu'on ne lit jamais que sa propre ligne.
  async isSuspended(tenantId: string): Promise<boolean> {
    return this.tenant.run(tenantId, async (db) => {
      const rows = await db
        .select({ suspendedAt: tenants.suspendedAt })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1)
      return (rows[0]?.suspendedAt ?? null) !== null
    })
  }

  // Suspension opérateur (POST /admin/tenants/:id/suspend, spec §3) — UPDATE
  // conditionnel (`suspended_at IS NULL`) puis INSERT admin_actions DANS LA
  // MÊME TRANSACTION (`tenant.run` = un seul BEGIN/COMMIT, cf.
  // tenant-context.ts) : soit les deux écritures s'appliquent, soit aucune —
  // jamais une suspension journalisée à moitié. `admin_actions` n'a AUCUNE
  // RLS (migration 0031, table plateforme append-only) : l'INSERT réussit
  // sans lien avec `app.tenant_id`, posé ici uniquement pour satisfaire la
  // policy `tenant_self` de `tenants`.
  //
  // 0 ligne affectée par l'UPDATE est ambigu (tenant inconnu OU déjà
  // suspendu) — un SELECT de départage tranche (motif
  // `BillingRepository.applyEvent`), SANS écrire l'action dans ce cas (rien
  // à journaliser, aucun état n'a changé).
  async suspend(
    tenantId: string,
    adminId: string,
    reason: string,
  ): Promise<SuspendOutcome> {
    // Valeur posée AVANT l'UPDATE (pas relue via `.returning()`) : la colonne
    // `suspended_at` est nullable dans le schéma, donc `.returning()` la
    // typerait `Date | null` même quand ON SAIT qu'elle vient d'être posée
    // non-null — utiliser directement `suspendedAt` évite le cast et garantit
    // que la valeur journalisée en réponse HTTP est EXACTEMENT celle écrite.
    const suspendedAt = new Date()
    return this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(tenants)
        .set({ suspendedAt, suspendedReason: reason })
        .where(and(eq(tenants.id, tenantId), isNull(tenants.suspendedAt)))
        .returning({ id: tenants.id })
      const row = updated[0]
      if (!row) {
        const existing = await db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1)
        return existing.length === 0
          ? { outcome: 'not_found' }
          : { outcome: 'already_suspended' }
      }
      await db.insert(adminActions).values({
        adminId,
        tenantId,
        action: 'suspend_tenant',
        detail: { reason },
      })
      return { outcome: 'suspended', suspendedAt }
    })
  }

  // Réactivation (POST /admin/tenants/:id/unsuspend, spec §3) — symétrique de
  // `suspend` : UPDATE conditionnel (`suspended_at IS NOT NULL`) + INSERT
  // admin_actions même transaction, `detail: {}` (aucun motif à journaliser
  // pour une réactivation, contrairement à la suspension). `suspended_reason`
  // est effacé AVEC `suspended_at` (jamais conservé seul, motif commentaire
  // schema.ts) : un motif orphelin laisserait croire qu'un tenant actif a
  // encore une raison de suspension pendante.
  async unsuspend(
    tenantId: string,
    adminId: string,
  ): Promise<UnsuspendOutcome> {
    return this.tenant.run(tenantId, async (db) => {
      const updated = await db
        .update(tenants)
        .set({ suspendedAt: null, suspendedReason: null })
        .where(and(eq(tenants.id, tenantId), isNotNull(tenants.suspendedAt)))
        .returning({ id: tenants.id })
      if (updated.length === 0) {
        const existing = await db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .limit(1)
        return existing.length === 0
          ? { outcome: 'not_found' }
          : { outcome: 'not_suspended' }
      }
      await db.insert(adminActions).values({
        adminId,
        tenantId,
        action: 'unsuspend_tenant',
        detail: {},
      })
      return { outcome: 'unsuspended' }
    })
  }

  // Journalisation générique admin_actions (Task 5, spec §3, retry_jobs) —
  // contrairement à suspend/unsuspend ci-dessus, cette écriture n'a AUCUN
  // tenant à scoper (`tenantId` nullable : retry_jobs journalise `null`,
  // action cross-tenant par nature, une file BullMQ n'appartient à aucun
  // tenant précis) : un simple INSERT direct sur le pool applicatif suffit,
  // SANS passer par `tenant.run` — `admin_actions` n'a AUCUNE RLS (migration
  // 0031 : GRANT SELECT/INSERT à factelec_app sans policy, motif commentaire
  // migration « table plateforme, pas tenant-scopée »), donc aucun
  // `app.tenant_id` n'est requis pour que cet INSERT réussisse.
  async logAction(
    adminId: string,
    action: string,
    tenantId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      'INSERT INTO admin_actions (admin_id, action, tenant_id, detail) VALUES ($1, $2, $3, $4::jsonb)',
      [adminId, action, tenantId, JSON.stringify(detail)],
    )
  }
}
