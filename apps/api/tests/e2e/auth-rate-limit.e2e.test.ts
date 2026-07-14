import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('auth rate limiting (e2e)', () => {
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

  it('throttles brute-force login attempts (429 after 10)', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'nobody@x.example', password: 'bad-password-1' })
    for (let i = 0; i < 10; i++) await attempt()
    await attempt().expect(429)
  })
})
