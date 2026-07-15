import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseApiKeyToken } from '../../src/auth/api-key.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

describe('authenticate_api_key writes last_used_at (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let token: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('sets last_used_at on prefix match (was null after seeding)', async () => {
    const prefix = parseApiKeyToken(token)?.prefix
    const before = await ownerPool.query(
      'SELECT last_used_at FROM api_keys WHERE prefix = $1',
      [prefix],
    )
    expect(before.rows[0].last_used_at).toBeNull()

    const auth = await appPool.query(
      'SELECT api_key_id, tenant_id FROM authenticate_api_key($1)',
      [prefix],
    )
    expect(auth.rows).toHaveLength(1)

    const after = await ownerPool.query(
      'SELECT last_used_at FROM api_keys WHERE prefix = $1',
      [prefix],
    )
    expect(after.rows[0].last_used_at).not.toBeNull()
  })

  it('returns no row for an unknown prefix (and writes nothing)', async () => {
    const r = await appPool.query(
      'SELECT api_key_id FROM authenticate_api_key($1)',
      ['deadbeefdeadbeefdeadbeef'],
    )
    expect(r.rowCount).toBe(0)
  })

  it('a revoked key resolves no row (401 upstream) and does NOT update last_used_at', async () => {
    const { token: revokedToken } = await seedTenantWithKey(
      ownerPool,
      'Revoked',
    )
    const prefix = parseApiKeyToken(revokedToken)?.prefix
    await ownerPool.query(
      'UPDATE api_keys SET revoked_at = now() WHERE prefix = $1',
      [prefix],
    )

    const auth = await appPool.query(
      'SELECT api_key_id FROM authenticate_api_key($1)',
      [prefix],
    )
    expect(auth.rowCount).toBe(0)

    const after = await ownerPool.query(
      'SELECT last_used_at FROM api_keys WHERE prefix = $1',
      [prefix],
    )
    expect(after.rows[0].last_used_at).toBeNull()
  })
})
