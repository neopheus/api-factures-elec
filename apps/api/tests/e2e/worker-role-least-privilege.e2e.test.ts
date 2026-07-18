import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Preuve de moindre privilège du rôle factelec_worker (D4/D5, Task 3, plan
// 3.5) — suite LIGHT : pool `pg` BRUT connecté directement en factelec_worker
// (AUCUN `createTestWorker`, aucun Worker BullMQ, motif rls.e2e.test.ts) : le
// verrou `heavy-suites.arch` (tests/unit/heavy-suites.arch.test.ts) reste
// vert. Oracle indépendant : les vecteurs positifs/négatifs viennent
// EXCLUSIVEMENT de la matrice d'inventaire D4 (accès réel des 5 processors +
// sweeps du worker), pas du contenu de la migration 0029 elle-même.
//
// Minimalité (ce fichier) : contrôles positifs (le worker peut faire ce dont
// il a besoin) + contrôles négatifs 42501 (le worker NE PEUT PAS accéder aux
// tables/fonctions d'auth/admin). Suffisance : prouvée séparément par TOUTE
// la suite e2e worker HEAVY tournant sous ce même rôle (Step 4, rapport
// Task 3) — si un GRANT manquait, une de ces suites échouerait 42501.
describe('factelec_worker : moindre privilège (DB level)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let workerPool: pg.Pool
  let tenantA: string
  let invoiceA: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    workerPool = new pg.Pool({ connectionString: db.workerUrl })
    // Semis via le rôle owner (BYPASSRLS) — chemin privilégié, hors requête
    // worker (motif rls.e2e.test.ts).
    const a = await ownerPool.query(
      "INSERT INTO tenants (name) VALUES ('Tenant Worker A') RETURNING id",
    )
    tenantA = a.rows[0].id
    const inv = await ownerPool.query(
      `INSERT INTO invoices (tenant_id, number, type_code, issue_date, currency, canonical)
       VALUES ($1, 'FA-W-1', '380', '2026-07-13', 'EUR', '{}'::jsonb) RETURNING id`,
      [tenantA],
    )
    invoiceA = inv.rows[0].id
  })

  afterAll(async () => {
    await workerPool.end()
    await ownerPool.end()
    await db.stop()
  })

  it('positif : SELECT et UPDATE invoices réussissent (sous contexte tenant)', async () => {
    const client = await workerPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantA,
      ])
      const select = await client.query(
        'SELECT id FROM invoices WHERE id = $1',
        [invoiceA],
      )
      expect(select.rowCount).toBe(1)
      const update = await client.query(
        "UPDATE invoices SET recipient_platform = 'TEST' WHERE id = $1",
        [invoiceA],
      )
      expect(update.rowCount).toBe(1)
      await client.query('COMMIT')
    } finally {
      client.release()
    }
  })

  it('positif : EXECUTE find_pending_routing_invoices($1) réussit', async () => {
    const r = await workerPool.query(
      'SELECT * FROM find_pending_routing_invoices($1)',
      [10],
    )
    expect(Array.isArray(r.rows)).toBe(true)
  })

  it('négatif 42501 : INSERT api_keys, UPDATE users, SELECT sessions, INSERT annuaire_consents, SELECT tenants', async () => {
    await expect(
      workerPool.query('INSERT INTO api_keys DEFAULT VALUES'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      workerPool.query("UPDATE users SET email = 'x@example.com'"),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      workerPool.query('SELECT 1 FROM sessions'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      workerPool.query('INSERT INTO annuaire_consents DEFAULT VALUES'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      workerPool.query('SELECT 1 FROM tenants'),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('négatif 42501 : EXECUTE authenticate_api_key(text) (SD auth non accordée au worker)', async () => {
    await expect(
      workerPool.query("SELECT authenticate_api_key('deadbeef')"),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
