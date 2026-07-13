import pg from 'pg'
import { hashPassword } from '../src/auth/password.js'

async function main(): Promise<void> {
  const [email, password] = process.argv.slice(2)
  if (!email || !password)
    throw new Error('usage: provision:admin <email> <password>')
  const ownerUrl = process.env.DATABASE_OWNER_URL
  if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required')
  const pool = new pg.Pool({ connectionString: ownerUrl })
  try {
    const hash = await hashPassword(password)
    const res = await pool.query(
      'INSERT INTO platform_admins (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hash],
    )
    console.log(JSON.stringify({ adminId: res.rows[0].id, email }, null, 2))
  } finally {
    await pool.end()
  }
}

void main()
