import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import {
  extractCookie,
  type Session,
  signupSession,
} from './helpers/session.js'

const ownerInput = {
  email: 'owner@a.example',
  password: 'owner-passphrase-123',
  organizationName: 'Tenant A',
  siren: '732829320',
}

// Seme un utilisateur d'un rôle donné dans le tenant du owner (invitation
// différée en 1.4 → insertion directe), puis ouvre sa session.
async function seedRoleSession(
  app: INestApplication,
  ownerPool: pg.Pool,
  email: string,
  password: string,
  role: 'owner' | 'admin' | 'accountant' | 'viewer',
): Promise<Session> {
  const tenantRow = await ownerPool.query(
    'SELECT tenant_id FROM authenticate_user($1)',
    [ownerInput.email],
  )
  const tenantId = tenantRow.rows[0].tenant_id
  const hash = await hashPassword(password)
  await ownerPool.query(
    'INSERT INTO users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4)',
    [tenantId, email, hash, role],
  )
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200)
  const cookie = login.headers['set-cookie'] as unknown as string[]
  return { cookie, csrf: extractCookie(cookie, 'factelec_csrf') }
}

describe('api keys management (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool
  let sess: Session

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    sess = await signupSession(app, ownerInput)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('refuses key creation without a CSRF token (403)', async () => {
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .send({ label: 'no-csrf' })
      .expect(403)
  })

  it('refuses key creation with an API key bearer token instead of a session (401)', async () => {
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Authorization', 'Bearer fk_000000000000000000000000.irrelevant')
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'bearer-not-allowed' })
      .expect(401)
  })

  it('creates a key, returns the secret ONCE, and the key authenticates machine calls', async () => {
    const res = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'prod' })
      .expect(201)
    expect(res.body).toMatchObject({ label: 'prod' })
    expect(res.body.prefix).toMatch(/^[0-9a-f]{24}$/)
    expect(res.body.token).toMatch(/^fk_[0-9a-f]{24}\./)
    // Le hash du secret ne quitte jamais le serveur : seul le token clair
    // (affiché une fois) sort dans la réponse de création.
    expect(res.body).not.toHaveProperty('secretHash')
    expect(res.body).not.toHaveProperty('secret_hash')
    // La clé fonctionne pour l'auth machine (bout en bout).
    await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${res.body.token}`)
      .expect(200)
  })

  it('lists keys with prefixes only (never the secret)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api-keys')
      .set('Cookie', sess.cookie)
      .expect(200)
    expect(Array.isArray(res.body)).toBe(true)
    for (const k of res.body) {
      expect(k).toHaveProperty('prefix')
      expect(k).not.toHaveProperty('token')
      expect(k).not.toHaveProperty('secretHash')
      expect(k).not.toHaveProperty('secret_hash')
    }
  })

  it('revokes a key so it no longer authenticates', async () => {
    const created = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'to-revoke' })
      .expect(201)
    await request(app.getHttpServer())
      .delete(`/api-keys/${created.body.id}`)
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .expect(204)
    await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${created.body.token}`)
      .expect(401)
  })

  it('rejects revocation of a malformed id (404, never a DB error)', async () => {
    await request(app.getHttpServer())
      .delete('/api-keys/not-a-uuid')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .expect(404)
  })

  it('enforces roles: a viewer cannot create nor revoke keys (403)', async () => {
    const viewer = await seedRoleSession(
      app,
      ownerPool,
      'viewer@a.example',
      'viewer-passphrase-123',
      'viewer',
    )
    // Le viewer peut lister…
    await request(app.getHttpServer())
      .get('/api-keys')
      .set('Cookie', viewer.cookie)
      .expect(200)
    // …mais pas créer.
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', viewer.cookie)
      .set('X-CSRF-Token', viewer.csrf)
      .send({ label: 'nope' })
      .expect(403)
    // …ni révoquer une clé existante du tenant.
    const created = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'viewer-cannot-revoke' })
      .expect(201)
    await request(app.getHttpServer())
      .delete(`/api-keys/${created.body.id}`)
      .set('Cookie', viewer.cookie)
      .set('X-CSRF-Token', viewer.csrf)
      .expect(403)
  })

  it('enforces roles: an accountant can list but neither create nor revoke keys (403)', async () => {
    const accountant = await seedRoleSession(
      app,
      ownerPool,
      'accountant@a.example',
      'accountant-passphrase-123',
      'accountant',
    )
    // L'accountant peut lister…
    await request(app.getHttpServer())
      .get('/api-keys')
      .set('Cookie', accountant.cookie)
      .expect(200)
    // …mais pas créer.
    await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', accountant.cookie)
      .set('X-CSRF-Token', accountant.csrf)
      .send({ label: 'nope' })
      .expect(403)
    // …ni révoquer une clé existante du tenant.
    const created = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: 'accountant-cannot-revoke' })
      .expect(201)
    await request(app.getHttpServer())
      .delete(`/api-keys/${created.body.id}`)
      .set('Cookie', accountant.cookie)
      .set('X-CSRF-Token', accountant.csrf)
      .expect(403)
  })

  it('rejects an empty label on creation (422, zod schema contract)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api-keys')
      .set('Cookie', sess.cookie)
      .set('X-CSRF-Token', sess.csrf)
      .send({ label: '' })
      .expect(422)
    expect(res.body.type).toBe('urn:factelec:problem:validation-error')
    expect(
      res.body.errors.some((e: { path: string }) => e.path === 'label'),
    ).toBe(true)
  })

  it('isolates tenants: B cannot see or revoke A keys', async () => {
    const bSess = await signupSession(app, {
      email: 'owner@b.example',
      password: 'owner-b-passphrase-1',
      organizationName: 'Tenant B',
      siren: null,
    })
    const aList = await request(app.getHttpServer())
      .get('/api-keys')
      .set('Cookie', sess.cookie)
      .expect(200)
    const bList = await request(app.getHttpServer())
      .get('/api-keys')
      .set('Cookie', bSess.cookie)
      .expect(200)
    expect(bList.body.length).toBe(0)
    await request(app.getHttpServer())
      .delete(`/api-keys/${aList.body[0].id}`)
      .set('Cookie', bSess.cookie)
      .set('X-CSRF-Token', bSess.csrf)
      .expect(404) // clé de A invisible pour B (RLS) → 404, jamais 204
  })
})
