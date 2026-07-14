import { Inject, Injectable } from '@nestjs/common'
// biome-ignore lint/style/useImportType: ConfigService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import type { EnvConfig } from '../config/env.js'
import { APP_POOL } from '../db/client.js'
import type { UserRole } from './auth.types.js'
import { generateOpaqueToken, hashToken } from './session-token.js'

export interface SessionSubject {
  sessionId: string
  userId: string | null
  adminId: string | null
  tenantId: string | null
  role: UserRole | null
  csrfHash: string
}
export interface IssuedSession {
  token: string
  csrfToken: string
  expiresAt: Date
}

@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  ttlMs(): number {
    return this.config.get('SESSION_TTL_HOURS', { infer: true }) * 3_600_000
  }

  async create(subject: {
    userId?: string
    adminId?: string
    tenantId?: string
  }): Promise<IssuedSession> {
    const session = generateOpaqueToken()
    const csrf = generateOpaqueToken()
    // Expiration ABSOLUE, fixée une fois pour toutes à l'émission : aucun
    // renouvellement glissant à la lecture (cf. find(), amendement D1).
    const expiresAt = new Date(Date.now() + this.ttlMs())
    await this.pool.query('SELECT create_session($1, $2, $3, $4, $5, $6)', [
      subject.userId ?? null,
      subject.adminId ?? null,
      subject.tenantId ?? null,
      session.tokenHash,
      csrf.tokenHash,
      expiresAt,
    ])
    return { token: session.token, csrfToken: csrf.token, expiresAt }
  }

  async find(token: string): Promise<SessionSubject | null> {
    const res = await this.pool.query(
      'SELECT session_id, user_id, admin_id, tenant_id, role, csrf_hash, expires_at FROM find_session($1)',
      [hashToken(token)],
    )
    const row = res.rows[0]
    if (!row) return null
    // Expiration vérifiée côté application, à chaque lecture — jamais prolongée
    // ici (pas de UPDATE expires_at) : expiration strictement absolue.
    if (new Date(row.expires_at).getTime() <= Date.now()) return null
    return {
      sessionId: row.session_id,
      userId: row.user_id,
      adminId: row.admin_id,
      tenantId: row.tenant_id,
      role: row.role,
      csrfHash: row.csrf_hash,
    }
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query('SELECT revoke_session($1)', [hashToken(token)])
  }
}
