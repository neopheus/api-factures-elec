import type { INestApplication } from '@nestjs/common'
import { generateSecret, generate as generateTotp } from 'otplib'
import type pg from 'pg'
import request from 'supertest'
import { hashPassword } from '../../../src/auth/password.js'

export interface SeededAdmin {
  email: string
  password: string
  secret: string
}

// Seed d'un admin plateforme DÉJÀ enrôlé TOTP (totp_secret + totp_enabled_at
// posés directement en SQL owner) — pour les e2e qui n'exercent PAS le MFA
// lui-même (admin.e2e/admin-supervision.e2e/admin-jobs-retry.e2e), qui
// n'ont besoin que d'une session admin authentifiée. Le cycle d'enrôlement
// complet (202 → confirm → recovery codes) n'est couvert QU'UNE SEULE fois,
// par admin-totp.e2e.test.ts (Task 7, spec §5) — motif : éviter de dupliquer
// N fois la même couverture MFA dans chaque suite qui a simplement besoin
// d'un admin connecté.
export async function seedEnrolledAdmin(
  ownerPool: pg.Pool,
  email: string,
  password: string,
): Promise<SeededAdmin> {
  const hash = await hashPassword(password)
  const secret = generateSecret()
  await ownerPool.query(
    `INSERT INTO platform_admins (email, password_hash, totp_secret, totp_enabled_at)
     VALUES ($1, $2, $3, now())`,
    [email, hash, secret],
  )
  return { email, password, secret }
}

// Code TOTP courant, calculé DEPUIS le secret (jamais une valeur fixe/mockée
// — même horloge que TotpService.verify côté serveur, cf. totp.service.ts).
export function currentTotpCode(secret: string): Promise<string> {
  return generateTotp({ secret })
}

// Login complet (password + totpCode courant) d'un admin déjà enrôlé —
// équivalent du `adminCookie()` historique de ces suites, adapté au flux
// Task 7 (spec §5) : renvoie les cookies set-cookie de la réponse 200.
export async function adminLoginCookies(
  app: INestApplication,
  admin: SeededAdmin,
): Promise<string[]> {
  const res = await request(app.getHttpServer())
    .post('/admin/login')
    .send({
      email: admin.email,
      password: admin.password,
      totpCode: await currentTotpCode(admin.secret),
    })
    .expect(200)
  return res.headers['set-cookie'] as unknown as string[]
}
