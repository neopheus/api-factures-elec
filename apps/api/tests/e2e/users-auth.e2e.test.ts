import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

const signup = {
  email: 'owner@shop.example',
  password: 'a-strong-passphrase-123',
  organizationName: 'Ma Boutique',
  siren: '732829320',
}

describe('user auth (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  function cookies(res: request.Response): string[] {
    const raw = res.headers['set-cookie']
    return Array.isArray(raw) ? raw : raw ? [raw] : []
  }

  it('signs up, creating a user + tenant, and sets session + csrf cookies', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/signup')
      .send(signup)
      .expect(201)
    expect(res.body.user).toMatchObject({ email: signup.email, role: 'owner' })
    const set = cookies(res).join(';')
    expect(set).toContain('factelec_session=')
    expect(set).toContain('factelec_csrf=')
    expect(set).toContain('HttpOnly') // session httpOnly ; csrf lisible
    const t = await ownerPool.query(
      'SELECT count(*)::int AS n FROM tenants WHERE name = $1',
      [signup.organizationName],
    )
    expect(t.rows[0].n).toBe(1)
  })

  it('rejects a duplicate email with 409', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send(signup)
      .expect(409)
  })

  it('rejects a weak password with 422', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ ...signup, email: 'weak@shop.example', password: 'short' })
      .expect(422)
  })

  it('logs in with valid credentials and rejects wrong ones', async () => {
    const ok = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    expect(cookies(ok).join(';')).toContain('factelec_session=')
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: 'wrong-password-xxx' })
      .expect(401)
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@shop.example', password: signup.password })
      .expect(401)
  })

  it('login failures are indistinguishable (unknown email vs wrong password): identical 401 problem body', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: 'wrong-password-xxx' })
      .expect(401)
    const unknownEmail = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ghost@shop.example', password: signup.password })
      .expect(401)
    expect(wrongPassword.body).toEqual(unknownEmail.body)
    expect(wrongPassword.headers['content-type']).toContain(
      'application/problem+json',
    )
  })

  it('GET /auth/me returns the profile with a valid session, 401 without', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    const cookieHeader = cookies(login)
    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookieHeader)
      .expect(200)
    expect(me.body.user).toMatchObject({
      email: signup.email,
      role: 'owner',
      emailVerified: false,
    })
    await request(app.getHttpServer()).get('/auth/me').expect(401)
  })

  it('logs out: revokes the session so /auth/me is 401 afterwards', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    const cookieHeader = cookies(login)
    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', cookieHeader)
      .expect(204)
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookieHeader)
      .expect(401)
  })

  it('rejects an expired session (absolute expiry, no sliding renewal) with 401', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: signup.email, password: signup.password })
      .expect(200)
    const cookieHeader = cookies(login)
    const sessionCookie = cookieHeader.find((c) =>
      c.startsWith('factelec_session='),
    )
    expect(sessionCookie).toBeDefined()
    // Force l'expiration en base (rôle owner, hors RLS) : prouve que l'expiration
    // est appliquée côté application à la lecture, pas seulement au moment de
    // l'émission (pas de renouvellement glissant : cf. amendement D1).
    await ownerPool.query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute'",
    )
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookieHeader)
      .expect(401)
  })
})
