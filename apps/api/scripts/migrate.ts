import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

const url = process.env.DATABASE_OWNER_URL
if (!url) throw new Error('DATABASE_OWNER_URL is required for migrations')

const pool = new pg.Pool({ connectionString: url })
const db = drizzle(pool)
await migrate(db, { migrationsFolder: 'src/db/migrations' })
await pool.end()
