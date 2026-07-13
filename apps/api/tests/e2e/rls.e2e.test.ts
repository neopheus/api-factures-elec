import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('RLS tenant isolation (DB level)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let appPool: pg.Pool
  let tenantA: string
  let tenantB: string
  let invoiceA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    appPool = new pg.Pool({ connectionString: db.appUrl })
    // Semis via le rôle owner (BYPASSRLS) — chemin privilégié, hors requête HTTP.
    const a = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Tenant A') RETURNING id",
    )
    const b = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Tenant B') RETURNING id",
    )
    tenantA = a.rows[0].id
    tenantB = b.rows[0].id
    const inv = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, 'FA-A-1', '380', '2026-07-13', 'EUR', '{}'::jsonb) RETURNING id`,
      [tenantA],
    )
    invoiceA = inv.rows[0].id
  })

  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('factelec_app has neither superuser nor BYPASSRLS', async () => {
    const r = await appPool.query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false })
  })

  it('sees zero rows of another tenant', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      const r = await client.query('SELECT id FROM invoices WHERE id = $1', [
        invoiceA,
      ])
      expect(r.rowCount).toBe(0)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('sees its own rows once the context matches', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      const r = await client.query('SELECT id FROM invoices WHERE id = $1', [
        invoiceA,
      ])
      expect(r.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('cannot INSERT a row for a foreign tenant (WITH CHECK)', async () => {
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantB,
      ])
      await expect(
        client.query(
          `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
           VALUES ($1, 'FA-X', '380', '2026-07-13', 'EUR', '{}'::jsonb)`,
          [tenantA],
        ),
      ).rejects.toThrow(/row-level security/i)
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('fails closed with no tenant context set (no rows)', async () => {
    const r = await appPool.query('SELECT id FROM invoices')
    expect(r.rowCount).toBe(0)
  })
})
