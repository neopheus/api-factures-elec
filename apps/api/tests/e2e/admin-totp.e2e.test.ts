import type { INestApplication } from '@nestjs/common'
import { generate as generateTotp } from 'otplib'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { hashToken } from '../../src/auth/session-token.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { extractCookie } from './helpers/session.js'

const EMAIL = 'root@factelec.fr'
const PASSWORD = 'super-admin-passphrase-1'

// Task 7 (spec §5) : cycle complet MFA TOTP super admin — light (Postgres
// seul, aucun Worker/Redis, motif admin.e2e.test.ts). Suite SÉQUENTIELLE et
// DÉPENDANTE (motif admin-supervision.e2e.test.ts « suspend/unsuspend
// tenant » : un seul admin partagé, chaque `it` fait progresser son état
// MFA — l'ordre de déclaration EST le scénario).
//
// Budget throttle (spec §9, brief Task 7 — choix DOCUMENTÉ ici) :
// `/admin/login` reste plafonné 10/15min/IP, INCHANGÉ par cette tâche —
// aucun mécanisme de contournement par env n'existe pour CE throttle précis
// (contrairement au throttle GLOBAL RATE_LIMIT_LIMIT/RATE_LIMIT_TTL,
// bypassable via tests/e2e/helpers/rate-limit-env.ts : /admin/login pose son
// propre `@Throttle` par-route qui l'ignore, cf. admin.controller.ts). Ce
// fichier compte ses appels : 9 POST /admin/login au total (202 enrôlement,
// 200 via totpCode, 200 via recoveryCode, 401 rejeu recovery, 200+401 course
// concurrente réelle, 401×3 anti-oracle) — sous la limite de 10. `/admin/
// totp/confirm` a son PROPRE
// throttle indépendant (clé incluant le nom du handler, cf.
// ThrottlerGuard.generateKey) : le seul appel de ce fichier ne partage donc
// aucun budget avec /admin/login.
describe('MFA TOTP super admin — cycle complet (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let secret: string
  let recoveryCodes: string[]

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    const hash = await hashPassword(PASSWORD)
    await ownerPool.query(
      'INSERT INTO platform_admins (email, password_hash) VALUES ($1, $2)',
      [EMAIL, hash],
    )
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('1. login (password OK, non enrôlé) → 202 enrollmentRequired {otpauthUrl, secret}, AUCUN cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(202)

    expect(res.body.enrollmentRequired).toBe(true)
    expect(typeof res.body.secret).toBe('string')
    expect(res.body.otpauthUrl).toContain('otpauth://totp/')
    expect(res.body.otpauthUrl).toContain('Factelec')
    expect(res.headers['set-cookie']).toBeUndefined()
    secret = res.body.secret
  })

  it('2. confirm avec le code calculé depuis le secret PENDING → 200 { recoveryCodes } (10, format xxxx-xxxx)', async () => {
    const totpCode = await generateTotp({ secret })
    const res = await request(app.getHttpServer())
      .post('/admin/totp/confirm')
      .send({ email: EMAIL, password: PASSWORD, totpCode })
      .expect(200)

    expect(res.body.recoveryCodes).toHaveLength(10)
    for (const code of res.body.recoveryCodes) {
      expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/)
    }
    recoveryCodes = res.body.recoveryCodes

    const row = await ownerPool.query(
      'SELECT totp_enabled_at FROM platform_admins WHERE email = $1',
      [EMAIL],
    )
    expect(row.rows[0].totp_enabled_at).not.toBeNull()
  })

  it('3. login enrôlé avec totpCode → 200 + cookies, session expirant à ~2h (ADMIN_SESSION_TTL_HOURS), PAS 12h', async () => {
    const totpCode = await generateTotp({ secret })
    const before = Date.now()
    const res = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: PASSWORD, totpCode })
      .expect(200)
    const after = Date.now()

    expect(res.body).toEqual({
      admin: { id: expect.any(String), email: EMAIL },
    })
    const cookies = res.headers['set-cookie'] as unknown as string[]
    const sessionToken = extractCookie(cookies, 'factelec_session')

    const sessionRow = await ownerPool.query(
      'SELECT expires_at FROM sessions WHERE token_hash = $1',
      [hashToken(sessionToken)],
    )
    const expiresAt = new Date(sessionRow.rows[0].expires_at).getTime()
    const ADMIN_TTL_MS = 2 * 3_600_000
    const TOLERANCE_MS = 5 * 60_000 // quelques minutes (spec Task 7)
    expect(expiresAt).toBeGreaterThanOrEqual(
      before + ADMIN_TTL_MS - TOLERANCE_MS,
    )
    expect(expiresAt).toBeLessThanOrEqual(after + ADMIN_TTL_MS + TOLERANCE_MS)
    // ≠ TTL standard (SESSION_TTL_HOURS, 12h par défaut, aucun override e2e) :
    // une session de 12h dépasserait largement la borne haute ci-dessus.
    const STANDARD_TTL_MS = 12 * 3_600_000
    expect(expiresAt).toBeLessThan(before + STANDARD_TTL_MS - TOLERANCE_MS)
  })

  it('4. login enrôlé avec un recoveryCode valide → 200 + cookies ; le MÊME code rejoué ensuite → 401', async () => {
    const target = recoveryCodes[0]!
    await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: PASSWORD, recoveryCode: target })
      .expect(200)

    const replay = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: PASSWORD, recoveryCode: target })
      .expect(401)
    expect(replay.body.type).toBe('urn:factelec:problem:unauthorized')
  })

  // Revue sécurité Task 7, Issue 1 (TOCTOU double-spend, migration 0032
  // amendée avec un CAS p_prior) : preuve à la Postgres RÉELLE, pas mockée
  // — deux requêtes envoyées SIMULTANÉMENT (`Promise.all`, pas séquentielles
  // comme le test 4 ci-dessus) avec le MÊME recoveryCode encore valide.
  // Le verrouillage ligne standard de l'UPDATE CAS (set_admin_recovery_codes)
  // sérialise les deux écritures : la première gagne (200), la seconde
  // réévalue son `WHERE recovery_codes = p_prior` contre l'état déjà modifié
  // par la première et échoue déterministiquement (401) — jamais les deux à
  // 200 (double-spend), jamais les deux à 401 (perte du code sans usage).
  it('4b. deux logins SIMULTANÉS avec le MÊME recoveryCode → un seul réussit (200), l’autre échoue (401)', async () => {
    const target = recoveryCodes[1]!
    const [first, second] = await Promise.all([
      request(app.getHttpServer())
        .post('/admin/login')
        .send({ email: EMAIL, password: PASSWORD, recoveryCode: target }),
      request(app.getHttpServer())
        .post('/admin/login')
        .send({ email: EMAIL, password: PASSWORD, recoveryCode: target }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 401])
  })

  it('5. anti-oracle : password faux / totpCode faux / totpCode+recoveryCode absents → le MÊME corps 401 (strict)', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: 'wrong-password-xxx' })
      .expect(401)

    const realCode = await generateTotp({ secret })
    // Code garanti FAUX (dernier chiffre décalé de 1 mod 10) — jamais un
    // hasard '000000' qui pourrait, à probabilité négligeable mais non
    // nulle, coïncider avec le vrai code.
    const wrongDigit = ((Number(realCode.at(-1)) + 1) % 10).toString()
    const wrongTotpCode = `${realCode.slice(0, -1)}${wrongDigit}`
    const wrongTotp = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: PASSWORD, totpCode: wrongTotpCode })
      .expect(401)

    const missingMfa = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: EMAIL, password: PASSWORD })
      .expect(401)

    expect(wrongPassword.body).toEqual(wrongTotp.body)
    expect(wrongPassword.body).toEqual(missingMfa.body)
    expect(wrongPassword.headers['content-type']).toContain(
      'application/problem+json',
    )
  })
})
