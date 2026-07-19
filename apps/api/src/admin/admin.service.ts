import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { timingSafeVerifyReject, verifyPassword } from '../auth/password.js'
import { ProblemType, problem } from '../common/problem.js'
import { APP_POOL } from '../db/client.js'
import type {
  AdminAnomaly,
  AdminTenantDetail,
  AdminTenantStats,
  SuspendOutcome,
  UnsuspendOutcome,
} from './admin-supervision.repository.js'
// biome-ignore lint/style/useImportType: AdminSupervisionRepository est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { AdminSupervisionRepository } from './admin-supervision.repository.js'
// biome-ignore lint/style/useImportType: TotpService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { TotpService } from './totp.service.js'

// Ligne renvoyée par authenticate_platform_admin (migration 0032, élargie à
// 5 colonnes — Task 7, spec §5) : shape brute pg (snake_case).
interface AuthenticatePlatformAdminRow {
  admin_id: string
  password_hash: string
  totp_secret: string | null
  totp_enabled_at: Date | null
  recovery_codes: string[] | null
}

// Entrée MFA optionnelle du login (spec §5) — au plus l'un des deux est
// renseigné (le contrôleur transmet tel quel ce que zod a laissé passer,
// aucun des deux n'est requis au niveau du schéma : c'est CETTE méthode qui
// tranche selon l'état d'enrôlement de l'admin).
export interface AdminLoginMfaInput {
  totpCode?: string
  recoveryCode?: string
}

// Union discriminée (motif SuspendOutcome/UnsuspendOutcome ci-dessous) : le
// contrôleur mappe `enrollment_required` sur 202 SANS session, `success`
// sur 200 + session TTL admin dédié. Un échec (password/TOTP/recovery
// invalide) ne fait JAMAIS partie de cette union — il lève directement une
// UnauthorizedException (motif historique de cette méthode), le corps 401
// étant STRICTEMENT identique quelle que soit la branche d'échec (anti-
// oracle, spec §5/§9).
export type AdminLoginResult =
  | { outcome: 'enrollment_required'; otpauthUrl: string; secret: string }
  | { outcome: 'success'; adminId: string }

@Injectable()
export class AdminService {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly supervision: AdminSupervisionRepository,
    private readonly totp: TotpService,
  ) {}

  // Corps 401 UNIQUE, réutilisé par TOUTES les branches d'échec de login()
  // ET confirmTotp() ci-dessous — email inconnu, mot de passe erroné, code
  // TOTP faux ou absent, recovery code invalide : STRICTEMENT le même
  // problem (anti-oracle, spec §5 « pas d'oracle password OK mais TOTP
  // faux », asserté byte-à-byte en test unit/e2e).
  private invalid(): UnauthorizedException {
    return new UnauthorizedException(
      problem(401, ProblemType.unauthorized, 'Unauthorized', {
        detail: 'Invalid credentials',
      }),
    )
  }

  // Flux complet (spec §5, remplace l'ancien login email/password seul) :
  //   1. email/password erronés → 401 (this.invalid(), inchangé)
  //   2. password OK + non enrôlé (totp_enabled_at NULL) → pose/réutilise un
  //      secret PENDING, renvoie `enrollment_required` (202 côté contrôleur,
  //      AUCUNE session créée)
  //   3. password OK + enrôlé → exige totpCode OU recoveryCode valide, sinon
  //      401 IDENTIQUE à l'étape 1 ; succès → `success` (200 + session TTL
  //      admin dédié, posée par le contrôleur).
  async login(
    email: string,
    password: string,
    mfa: AdminLoginMfaInput,
  ): Promise<AdminLoginResult> {
    const res = await this.pool.query<AuthenticatePlatformAdminRow>(
      'SELECT admin_id, password_hash, totp_secret, totp_enabled_at, recovery_codes FROM authenticate_platform_admin($1)',
      [email],
    )
    const row = res.rows[0]
    if (!row) {
      await timingSafeVerifyReject(password) // temps égalisé (anti-énumération)
      throw this.invalid()
    }
    if (!(await verifyPassword(row.password_hash, password))) {
      throw this.invalid()
    }

    // Password correct au-delà de ce point : enrôlement PENDING d'abord
    // (aucun TOTP à vérifier tant que l'admin n'a rien confirmé).
    if (!row.totp_enabled_at) {
      let secret = row.totp_secret
      if (!secret) {
        // set_admin_totp_secret_pending (migration 0032) renvoie la valeur
        // DÉFINITIVE post-écriture (coalesce), jamais garanti être CELLE
        // générée ici en cas de course avec une autre requête concurrente —
        // c'est TOUJOURS le retour SQL qui fait foi pour otpauthUrl.
        const generated = this.totp.generateSecret()
        const pending = await this.pool.query<{
          set_admin_totp_secret_pending: string
        }>('SELECT set_admin_totp_secret_pending($1, $2)', [
          row.admin_id,
          generated,
        ])
        secret = pending.rows[0]?.set_admin_totp_secret_pending ?? generated
      }
      return {
        outcome: 'enrollment_required',
        otpauthUrl: this.totp.otpauthUrl(email, secret),
        secret,
      }
    }

    // Enrôlé : totpCode OU recoveryCode requis, sinon 401 générique
    // (aucune distinction avec un mauvais mot de passe — anti-oracle).
    const secret = row.totp_secret
    if (mfa.totpCode) {
      if (!secret || !(await this.totp.verify(secret, mfa.totpCode))) {
        throw this.invalid()
      }
      return { outcome: 'success', adminId: row.admin_id }
    }
    if (mfa.recoveryCode) {
      const hashedCodes = row.recovery_codes ?? []
      const { ok, remaining } = await this.totp.consumeRecoveryCode(
        hashedCodes,
        mfa.recoveryCode,
      )
      if (!ok) throw this.invalid()
      await this.pool.query('SELECT set_admin_recovery_codes($1, $2::jsonb)', [
        row.admin_id,
        JSON.stringify(remaining),
      ])
      return { outcome: 'success', adminId: row.admin_id }
    }
    throw this.invalid() // ni totpCode ni recoveryCode fourni
  }

  // POST /admin/totp/confirm (spec §5, Task 7) — hors session (l'admin n'en
  // a pas encore). Vérifie password + code contre le secret PENDING, pose
  // totp_enabled_at et génère les 10 recovery codes (SEULE fois où ils
  // apparaissent en clair, jamais journalisés/relogués). Mêmes 401
  // génériques que login() pour toute branche d'échec (déjà enrôlé,
  // password faux, code faux) — mêmes motifs anti-oracle.
  async confirmTotp(
    email: string,
    password: string,
    totpCode: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const res = await this.pool.query<AuthenticatePlatformAdminRow>(
      'SELECT admin_id, password_hash, totp_secret, totp_enabled_at, recovery_codes FROM authenticate_platform_admin($1)',
      [email],
    )
    const row = res.rows[0]
    if (!row) {
      await timingSafeVerifyReject(password)
      throw this.invalid()
    }
    if (!(await verifyPassword(row.password_hash, password))) {
      throw this.invalid()
    }
    // Déjà enrôlé, ou jamais passé par /admin/login (aucun secret PENDING) :
    // même 401 générique, aucune distinction visible côté client.
    if (row.totp_enabled_at || !row.totp_secret) throw this.invalid()
    if (!(await this.totp.verify(row.totp_secret, totpCode))) {
      throw this.invalid()
    }

    const { plain, hashed } = await this.totp.generateRecoveryCodes()
    const confirmed = await this.pool.query<{
      confirm_admin_totp: boolean | null
    }>('SELECT confirm_admin_totp($1, $2::jsonb)', [
      row.admin_id,
      JSON.stringify(hashed),
    ])
    // 0 ligne affectée côté SQL (course avec une autre confirmation
    // concurrente entre la lecture ci-dessus et cette écriture) → NULL —
    // même 401 générique, rien n'a changé en base.
    if (!confirmed.rows[0]?.confirm_admin_totp) throw this.invalid()

    return { recoveryCodes: plain }
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

  // Task 6 (spec §3) : pur délégateur (motif listTenants/tenantDetail
  // ci-dessus) — la requête SQL (SD 2 find_admin_anomalies) et le mapping
  // vivent entièrement dans AdminSupervisionRepository ; `limit` est déjà
  // validé (1..200) par AdminController avant d'arriver ici.
  async anomalies(limit: number): Promise<AdminAnomaly[]> {
    return this.supervision.anomalies(limit)
  }
}
