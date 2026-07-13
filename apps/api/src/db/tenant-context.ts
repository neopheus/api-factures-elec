import { drizzle } from 'drizzle-orm/node-postgres'
import type pg from 'pg'
import type { Db } from './client.js'
import * as schema from './schema.js'

// Exécute `work` dans UNE transaction où app.tenant_id est posé en SET LOCAL
// (set_config(..., true) → is_local=true) : réinitialisé au COMMIT/ROLLBACK,
// donc aucune fuite de tenant entre requêtes sur une connexion mutualisée.
export async function runInTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  work: (db: Db) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      tenantId,
    ])
    const db = drizzle(client, { schema })
    const result = await work(db)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
