import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { timingSafeVerifyReject, verifyPassword } from '../auth/password.js'
import { ProblemType, problem } from '../common/problem.js'
import { APP_POOL } from '../db/client.js'
import type {
  AdminTenantDetail,
  AdminTenantStats,
  SuspendOutcome,
  UnsuspendOutcome,
} from './admin-supervision.repository.js'
// biome-ignore lint/style/useImportType: AdminSupervisionRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminSupervisionRepository } from './admin-supervision.repository.js'

@Injectable()
export class AdminService {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly supervision: AdminSupervisionRepository,
  ) {}

  async login(email: string, password: string): Promise<{ adminId: string }> {
    const res = await this.pool.query(
      'SELECT admin_id, password_hash FROM authenticate_platform_admin($1)',
      [email],
    )
    const row = res.rows[0]
    // Corps 401 identique (aucun détail distinctif) pour les deux échecs
    // possibles : email inconnu ou mot de passe erroné (même contrat que
    // UsersService.login).
    const invalid = () =>
      new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized', {
          detail: 'Invalid credentials',
        }),
      )
    if (!row) {
      await timingSafeVerifyReject(password) // temps égalisé (anti-énumération)
      throw invalid()
    }
    if (!(await verifyPassword(row.password_hash, password))) throw invalid()
    return { adminId: row.admin_id }
  }

  // Task 3 (spec §3) : liste enrichie déléguée au repository (SD 1
  // find_admin_tenant_stats, migration 0031) — remplace l'ancienne requête
  // directe à list_tenants_for_admin() (compteurs users/invoices bruts,
  // sans billing/anomalies). Contrat HTTP élargi côté contrôleur
  // (AdminController.listTenants enveloppe dans `{ tenants }`).
  async listTenants(): Promise<AdminTenantStats[]> {
    return this.supervision.tenantStats()
  }

  // null = tenant inconnu → 404 problem posé par AdminController.
  async tenantDetail(tenantId: string): Promise<AdminTenantDetail | null> {
    return this.supervision.tenantDetail(tenantId)
  }

  // Task 4 (spec §3) : pur délégateur (motif listTenants/tenantDetail
  // ci-dessus) — la logique (UPDATE conditionnel + journal admin_actions
  // même transaction) vit entièrement dans le repository ; le mapping de
  // `SuspendOutcome`/`UnsuspendOutcome` vers les codes HTTP (404/409/200/204)
  // reste au contrôleur (motif `tenantDetail` : null → 404 posé là-bas).
  async suspendTenant(
    tenantId: string,
    adminId: string,
    reason: string,
  ): Promise<SuspendOutcome> {
    return this.supervision.suspend(tenantId, adminId, reason)
  }

  async unsuspendTenant(
    tenantId: string,
    adminId: string,
  ): Promise<UnsuspendOutcome> {
    return this.supervision.unsuspend(tenantId, adminId)
  }
}
