import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import type pg from 'pg'
import { timingSafeVerifyReject, verifyPassword } from '../auth/password.js'
import { ProblemType, problem } from '../common/problem.js'
import { APP_POOL } from '../db/client.js'

export interface TenantOverview {
  id: string
  name: string
  siren: string | null
  createdAt: Date
  userCount: number
  invoiceCount: number
}

@Injectable()
export class AdminService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

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

  async listTenants(): Promise<TenantOverview[]> {
    const res = await this.pool.query(
      'SELECT id, name, siren, created_at, user_count, invoice_count FROM list_tenants_for_admin()',
    )
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      siren: r.siren,
      createdAt: r.created_at,
      userCount: Number(r.user_count),
      invoiceCount: Number(r.invoice_count),
    }))
  }
}
