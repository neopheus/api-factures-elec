import pg from 'pg'
import { generateApiKey } from '../src/auth/api-key.js'

const ownerUrl = process.env.DATABASE_OWNER_URL
if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required')
const name = process.argv[2]
if (!name) throw new Error('usage: provision:tenant <name> [label]')
const label = process.argv[3] ?? 'default'

const pool = new pg.Pool({ connectionString: ownerUrl })
try {
  const key = await generateApiKey()
  const client = await pool.connect()
  let tenantId: string
  try {
    // Transaction : les deux INSERT réussissent ou aucun — un échec entre le
    // tenant et sa clé (ex: contrainte violée sur api_keys) ne doit jamais
    // laisser un tenant orphelin sans clé.
    await client.query('BEGIN')
    const t = await client.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
      [name],
    )
    tenantId = t.rows[0].id
    await client.query(
      'INSERT INTO api_keys (tenant_id, prefix, secret_hash, label) VALUES ($1, $2, $3, $4)',
      [tenantId, key.prefix, key.secretHash, label],
    )
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
  // Le token n'est révélé qu'ICI, une seule fois.
  console.log(JSON.stringify({ tenantId, token: key.token }, null, 2))
} finally {
  await pool.end()
}
