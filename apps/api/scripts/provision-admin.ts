import { createInterface } from 'node:readline/promises'
import pg from 'pg'
import { hashPassword } from '../src/auth/password.js'

// Le mot de passe ne transite jamais par argv : visible via `ps`/`/proc` pour
// tout autre utilisateur de la machine, et persisté en clair dans l'historique
// du shell. Lu depuis PROVISION_ADMIN_PASSWORD (usage non-interactif, CI) ou
// saisi de façon interactive sur stdin sinon.
async function readPassword(): Promise<string> {
  const fromEnv = process.env.PROVISION_ADMIN_PASSWORD
  if (fromEnv) return fromEnv
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question('Mot de passe admin : ')
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const email = process.argv[2]
  if (!email) {
    throw new Error(
      'usage: provision:admin <email>  (mot de passe via PROVISION_ADMIN_PASSWORD ou saisie interactive)',
    )
  }
  const ownerUrl = process.env.DATABASE_OWNER_URL
  if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is required')
  const password = await readPassword()
  if (!password) throw new Error('mot de passe requis (saisie vide refusée)')
  const pool = new pg.Pool({ connectionString: ownerUrl })
  try {
    const hash = await hashPassword(password)
    try {
      const res = await pool.query(
        'INSERT INTO platform_admins (email, password_hash) VALUES ($1, $2) RETURNING id',
        [email, hash],
      )
      console.log(JSON.stringify({ adminId: res.rows[0].id, email }, null, 2))
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        // Anti-énumération inutile ici (script CLI opéré par un humain de
        // confiance, pas une surface HTTP publique) : message explicite.
        throw new Error(`Un admin existe déjà avec l'email ${email}.`)
      }
      throw err
    }
  } finally {
    await pool.end()
  }
}

main().catch((err: unknown) => {
  // Message clair sans stack trace brute : ce script est opéré à la main.
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
