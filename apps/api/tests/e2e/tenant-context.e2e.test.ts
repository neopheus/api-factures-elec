import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runInTenant } from '../../src/db/tenant-context.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('runInTenant (transaction + SET LOCAL)', () => {
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
      "INSERT INTO tenants (name) VALUES ('A') RETURNING id",
    )
    const b = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('B') RETURNING id",
    )
    tenantA = a.rows[0].id
    tenantB = b.rows[0].id
    await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, 'A-1', '380', '2026-07-13', 'EUR', '{}'::jsonb)`,
      [tenantA],
    )
  })
  afterAll(async () => {
    await appPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('scopes reads to the current tenant', async () => {
    const seenByA = await runInTenant(appPool, tenantA, async (d) => {
      const r = await d.execute(sql`SELECT count(*)::int AS n FROM invoices`)
      return (r.rows[0] as { n: number }).n
    })
    const seenByB = await runInTenant(appPool, tenantB, async (d) => {
      const r = await d.execute(sql`SELECT count(*)::int AS n FROM invoices`)
      return (r.rows[0] as { n: number }).n
    })
    expect(seenByA).toBe(1)
    expect(seenByB).toBe(0)
  })

  it('resets the GUC after the transaction (no leak on the pooled connection)', async () => {
    await runInTenant(appPool, tenantA, async (d) => {
      await d.execute(sql`SELECT 1`)
    })
    // Hors transaction, aucun contexte : fail-closed.
    const r = await appPool.query('SELECT count(*)::int AS n FROM invoices')
    expect(r.rows[0].n).toBe(0)
  })

  it('rolls back on error', async () => {
    await expect(
      runInTenant(appPool, tenantA, async (d) => {
        await d.execute(sql`INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
          VALUES (${tenantA}, 'A-2', '380', '2026-07-13', 'EUR', '{}'::jsonb)`)
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const after = await runInTenant(appPool, tenantA, async (d) => {
      const r = await d.execute(sql`SELECT count(*)::int AS n FROM invoices`)
      return (r.rows[0] as { n: number }).n
    })
    expect(after).toBe(1) // A-2 annulée
  })

  // --- Ajouts pilotés par la revue de la tâche 4 (Minor) et le contrôle de la tâche 5 ---

  it('fails closed on a connection explicitly dirtied by a COMMITted SET LOCAL, outside any transaction (verrouille le correctif nullif)', async () => {
    const client = await appPool.connect()
    try {
      // Dirtie explicitement CETTE connexion : set_config(..., true) posé puis
      // COMMITté (donc la transaction se termine réellement, pas un simple abort).
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      await client.query('COMMIT')
      // Hors transaction, sur LA MÊME connexion : current_setting revient à ''
      // (pas NULL — quirk Postgres pour un GUC placeholder déjà touché dans la
      // session). Sans nullif(...,'') dans la policy, ''::uuid lèverait une
      // exception de cast au lieu de fermer l'accès : ici on doit voir 0 ligne.
      const r = await client.query('SELECT id FROM invoices')
      expect(r.rowCount).toBe(0)
    } finally {
      client.release()
    }
  })

  it('releases the client back to the pool on both success and error paths under concurrent load (no pool exhaustion)', async () => {
    const smallPool = new pg.Pool({ connectionString: db.appUrl, max: 2 })
    try {
      const iterations = 8 // > max (2) du pool : verrouille l'absence de fuite de client.
      const calls = Array.from({ length: iterations }, (_, i) =>
        i % 2 === 0
          ? runInTenant(smallPool, tenantA, async (d) => {
              const r = await d.execute(
                sql`SELECT count(*)::int AS n FROM invoices`,
              )
              return (r.rows[0] as { n: number }).n
            })
          : runInTenant(smallPool, tenantA, async () => {
              throw new Error('boom')
            }).catch((err: unknown) => err),
      )

      const results = await Promise.all(calls)

      const successes = results.filter(
        (r): r is number => typeof r === 'number',
      )
      const errors = results.filter((r): r is Error => r instanceof Error)
      expect(successes).toHaveLength(iterations / 2)
      expect(successes.every((n) => n === 1)).toBe(true)
      expect(errors).toHaveLength(iterations / 2)
      expect(errors.every((e) => e.message === 'boom')).toBe(true)
    } finally {
      await smallPool.end()
    }
  })
})
