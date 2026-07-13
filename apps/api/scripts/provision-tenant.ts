import pg from 'pg'
import { generateApiKey } from '../src/auth/api-key.js'

const ownerUrl = process.env.DATABASE_OWNER_URL
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required')
const name = process.argv[2]
if (!name) throw new Error('usage: provision:tenant <name> [label]')
const label = process.argv[3] ?? 'default'

const pool = new pg.Pool({ connectionString: ownerUrl })
const t = await pool.query(
  'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
  [name],
)
const tenantId = t.rows[0].id
const key = await generateApiKey()
await pool.query(
  'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
  [tenantId, key.prefix, key.secretHash, label],
)
await pool.end()
// Le token n'est révélé qu'ICI, une seule fois.
console.log(JSON.stringify({ tenantId, token: key.token }, null, 2))
