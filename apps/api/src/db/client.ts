import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import type * as schema from './schema.js'

export const APP_POOL = Symbol('APP_POOL')
export type Db = NodePgDatabase<typeof schema>

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 10 })
  // Sans écouteur, un `error` émis par une connexion inactive du pool (ex :
  // 57P01 admin shutdown pendant le teardown testcontainers) remonte en
  // exception non gérée du process. C'est du bruit de teardown attendu —
  // on l'avale et le journalise, on ne relance JAMAIS.
  pool.on('error', (err) => {
    console.error('[db] erreur de pool avalée (bruit de teardown) :', err)
  })
  return pool
}
