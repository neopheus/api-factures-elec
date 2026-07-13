import { Inject, Injectable } from '@nestjs/common'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
import { parseApiKeyToken, timingSafeReject, verifySecret } from './api-key.js'

export interface AuthenticatedKey {
  apiKeyId: string
  tenantId: string
}

@Injectable()
export class ApiKeyService {
  constructor(@Inject(APP_POOL) private readonly pool: pg.Pool) {}

  // Renvoie le tenant si le token est valide et actif, sinon null. Ne distingue
  // jamais "préfixe inconnu" de "secret invalide" (pas d'oracle d'énumération).
  async authenticate(token: string): Promise<AuthenticatedKey | null> {
    const parsed = parseApiKeyToken(token)
    if (!parsed) return null

    const res = await this.pool.query<{
      api_key_id: string
      tenant_id: string
      secret_hash: string
      revoked_at: Date | null
    }>(
      'SELECT api_key_id, tenant_id, secret_hash, revoked_at FROM authenticate_api_key($1)',
      [parsed.prefix],
    )
    const row = res.rows[0]
    if (!row || row.revoked_at) {
      await timingSafeReject(parsed.secret)
      return null
    }
    if (!(await verifySecret(row.secret_hash, parsed.secret))) return null
    return { apiKeyId: row.api_key_id, tenantId: row.tenant_id }
  }
}
