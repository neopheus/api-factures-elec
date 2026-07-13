import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('users/sessions/admins isolation (DB level)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantA: string
  let tenantB: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    const a = await ownerPool.query(
      `SELECT user_id, tenant_id FROM signup_tenant('a@ex.com', 'hash-a', 'Tenant A', NULL)`,
    )
    tenantA = a.rows[0].tenant_id
    const b = await ownerPool.query(
      `SELECT user_id, tenant_id FROM signup_tenant('b@ex.com', 'hash-b', 'Tenant B', '123456789')`,
    )
    tenantB = b.rows[0].tenant_id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('signup_tenant created a tenant + owner user atomically', async () => {
    const r = await ownerPool.query(
      'SELECT role, email_verified FROM users WHERE tenant_id = $1',
      [tenantA],
    )
    expect(r.rows[0]).toMatchObject({ role: 'owner', email_verified: false })
  })

  it('rejects a duplicate email (global unique) → 23505', async () => {
    await expect(
      ownerPool.query(
        `SELECT signup_tenant('A@EX.COM', 'hash-x', 'Dup', NULL)`, // casse différente : même email
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('signup_tenant is atomic: a failed call leaves no orphan tenant behind', async () => {
    // La tentative précédente (email dupliqué) a échoué après l'INSERT tenants
    // mais avant l'INSERT users réussi : la fonction entière doit avoir été
    // annulée (pas de "Dup" orphelin sans utilisateur associé).
    const orphan = await ownerPool.query(
      "SELECT id FROM tenants WHERE name = 'Dup'",
    )
    expect(orphan.rowCount).toBe(0)
  })

  it('factelec_app sees users only within its tenant context', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      const foreign = await client.query(
        'SELECT id FROM users WHERE tenant_id = $1',
        [tenantA],
      )
      expect(foreign.rowCount).toBe(0)
      const own = await client.query(
        'SELECT id FROM users WHERE tenant_id = $1',
        [tenantB],
      )
      expect(own.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('factelec_app has no direct access to sessions or platform_admins (42501)', async () => {
    // Aucun GRANT direct : ces tables ne sont accessibles que via les fonctions SD.
    await expect(
      appPool.query('SELECT id FROM sessions'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      appPool.query('SELECT id FROM platform_admins'),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('find_session / revoke_session round-trip via SECURITY DEFINER', async () => {
    const u = await appPool.query('SELECT user_id FROM authenticate_user($1)', [
      'a@ex.com',
    ])
    const userId = u.rows[0].user_id
    await appPool.query(
      "SELECT create_session($1, NULL, $2, 'tok-hash-1', 'csrf-hash-1', now() + interval '1 hour')",
      [userId, tenantA],
    )
    const found = await appPool.query(
      'SELECT user_id, tenant_id, role FROM find_session($1)',
      ['tok-hash-1'],
    )
    expect(found.rows[0]).toMatchObject({
      user_id: userId,
      tenant_id: tenantA,
      role: 'owner',
    })
    await appPool.query('SELECT revoke_session($1)', ['tok-hash-1'])
    const gone = await appPool.query('SELECT user_id FROM find_session($1)', [
      'tok-hash-1',
    ])
    expect(gone.rowCount).toBe(0)
  })

  it('factelec_app is still NOBYPASSRLS / NOSUPERUSER', async () => {
    const r = await appPool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  })

  // Déviation Task 2 (couverte ici, Task 4) : preuve directe des contraintes
  // CHECK de `sessions` par des INSERT violateurs en connexion owner (hors
  // RLS, ce qui isole la contrainte testée de la RLS elle-même).
  it('rejects a session row with neither user_id nor admin_id (sessions_subject_xor, 23514)', async () => {
    await expect(
      ownerPool.query(
        "INSERT INTO sessions (user_id, admin_id, tenant_id, token_hash, csrf_hash, expires_at) VALUES (NULL, NULL, $1, 'xor-neither', 'csrf-x', now() + interval '1 hour')",
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects a session row with BOTH user_id and admin_id set (sessions_subject_xor, 23514)', async () => {
    await expect(
      ownerPool.query(
        "INSERT INTO sessions (user_id, admin_id, tenant_id, token_hash, csrf_hash, expires_at) VALUES (gen_random_uuid(), gen_random_uuid(), $1, 'xor-both', 'csrf-x', now() + interval '1 hour')",
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects an admin session row carrying a tenant_id (sessions_admin_no_tenant, 23514)', async () => {
    await expect(
      ownerPool.query(
        "INSERT INTO sessions (user_id, admin_id, tenant_id, token_hash, csrf_hash, expires_at) VALUES (NULL, gen_random_uuid(), $1, 'admin-with-tenant', 'csrf-x', now() + interval '1 hour')",
        [tenantA],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
