import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import type * as schema from './schema.js'

export const APP_POOL = Symbol('APP_POOL')
export type Db = NodePgDatabase<typeof schema>

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 })
}
