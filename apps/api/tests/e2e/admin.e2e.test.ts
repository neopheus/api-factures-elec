import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword } from '../../src/auth/password.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { signupSession } from './helpers/session.js'

describe('super admin (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  let ownerPool: pg.Pool

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    app = await createTestApp(db.appUrl)
    // Deux tenants (pour la liste) + un admin plateforme.
    await signupSession(app, {
      email: 'a@shop.example',
      password: 'passphrase-aaaaaa-1',
      organizationName: 'Shop A',
      siren: null,
    })
    await signupSession(app, {
      email: 'b@shop.example',
      password: 'passphrase-bbbbbb-1',
      organizationName: 'Shop B',
      siren: null,
    })
    const hash = await hashPassword('super-admin-passphrase-1')
    await ownerPool.query(
      "INSERT INTO platform_admins (email, password_hash) VALUES ('root@factelec.fr', $1)",
      [hash],
    )
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  async function adminCookie(): Promise<string[]> {
    const res = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'super-admin-passphrase-1' })
      .expect(200)
    return res.headers['set-cookie'] as unknown as string[]
  }

  it('logs in a platform admin and rejects bad credentials', async () => {
    await adminCookie()
    await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'wrong' })
      .expect(401)
  })

  it('login failures are indistinguishable (unknown email vs wrong password): identical 401 problem body', async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'root@factelec.fr', password: 'wrong-password-xxx' })
      .expect(401)
    const unknownEmail = await request(app.getHttpServer())
      .post('/admin/login')
      .send({
        email: 'ghost@factelec.fr',
        password: 'super-admin-passphrase-1',
      })
      .expect(401)
    expect(wrongPassword.body).toEqual(unknownEmail.body)
    expect(wrongPassword.headers['content-type']).toContain(
      'application/problem+json',
    )
  })

  it('rejects a malformed login body with 422 (never touches authenticate_platform_admin)', async () => {
    await request(app.getHttpServer())
      .post('/admin/login')
      .send({ email: 'not-an-email', password: 'whatever' })
      .expect(422)
  })

  // Vecteur modifié (Task 3, spec §3) : `GET /admin/tenants` renvoie
  // désormais `{ tenants: [...] }` (plus un tableau nu) avec les colonnes
  // enrichies de `find_admin_tenant_stats` (billing/volumes/anomalies) au
  // lieu de `userCount`/`invoiceCount` — la couverture détaillée de
  // l'enrichissement (billing actif, invoices30d, détail per-tenant, 404)
  // vit dans `tests/e2e/admin-supervision.e2e.test.ts` ; ce test-ci ne
  // vérifie plus que le contrat d'enveloppe minimal reste satisfait pour
  // les 2 tenants déjà seedés par ce fichier.
  it('lists all tenants for an authenticated admin', async () => {
    const cookie = await adminCookie()
    const res = await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookie)
      .expect(200)
    const names = res.body.tenants.map((t: { name: string }) => t.name)
    expect(names).toContain('Shop A')
    expect(names).toContain('Shop B')
    expect(res.body.tenants[0]).toHaveProperty('billingStatus')
    expect(res.body.tenants[0]).toHaveProperty('invoices30d')
    expect(res.body.tenants[0]).toHaveProperty('deadLetters')
  })

  it('forbids a tenant user from the admin area (403)', async () => {
    const user = await signupSession(app, {
      email: 'c@shop.example',
      password: 'passphrase-cccccc-1',
      organizationName: 'Shop C',
      siren: null,
    })
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', user.cookie)
      .expect(403)
  })

  it('forbids an admin session on tenant key management (403)', async () => {
    const cookie = await adminCookie()
    await request(app.getHttpServer())
      .get('/api-keys')
      .set('Cookie', cookie)
      .expect(403)
  })

  it('requires a session for the admin area (401)', async () => {
    await request(app.getHttpServer()).get('/admin/tenants').expect(401)
  })

  it('logs out an admin session (204): the cookie no longer opens /admin/tenants afterwards', async () => {
    const cookie = await adminCookie()
    await request(app.getHttpServer())
      .post('/admin/logout')
      .set('Cookie', cookie)
      .expect(204)
    await request(app.getHttpServer())
      .get('/admin/tenants')
      .set('Cookie', cookie)
      .expect(401)
  })
})
