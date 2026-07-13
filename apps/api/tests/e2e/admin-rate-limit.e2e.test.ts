import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Même politique de rate limiting que /auth/login (auth-rate-limit.e2e.test.ts) :
// /admin/login est une surface de brute-force au moins aussi sensible.
describe('admin login rate limiting (e2e)', () => {
  let db: TestDb
  let app: INestApplication
  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await db.stop()
  })

  it('throttles brute-force admin login attempts (429 after 10)', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/admin/login')
        .send({ email: 'nobody@factelec.fr', password: 'bad-password-1' })
    for (let i = 0; i < 10; i++) await attempt()
    await attempt().expect(429)
  })
})
