import type pg from 'pg'
import { generateApiKey } from '../../../src/auth/api-key.js'

export async function seedTenantWithKey(
  ownerPool: pg.Pool,
  name = 'Tenant',
): Promise<{ tenantId: string; token: string }> {
  const t = await ownerPool.query(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [name],
  )
  const tenantId = t.rows[0].id
  const key = await generateApiKey()
  await ownerPool.query(
    'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
    [tenantId, key.prefix, key.secretHash, 'test'],
  )
  return { tenantId, token: key.token }
}
