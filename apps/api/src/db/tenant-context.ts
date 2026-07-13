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
  // Non undefined UNIQUEMENT si le ROLLBACK lui-même échoue (connexion
  // probablement cassée) : sert alors à évincer le client du pool via
  // release(err) au lieu de le remettre en circulation.
  let evictionError: Error | undefined
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
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      // L'erreur du ROLLBACK ne doit JAMAIS remplacer l'erreur d'origine
      // (celle de `work` ou du COMMIT) remontée à l'appelant ci-dessous —
      // elle sert uniquement à décider de l'éviction de la connexion.
      evictionError =
        rollbackErr instanceof Error
          ? rollbackErr
          : new Error(String(rollbackErr))
    }
    throw err
  } finally {
    client.release(evictionError)
  }
}
