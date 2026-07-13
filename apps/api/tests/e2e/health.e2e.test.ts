import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

// Amendement A4 : depuis que HealthController dépend de APP_POOL (readiness DB,
// Task 5), monter HealthModule seul ne compile plus (APP_POOL non fourni). On
// bascule sur le helper createTestApp — app complète + Postgres réel, pas de mock.
describe('health (e2e)', () => {
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

  it('GET /health returns 200 { status: "ok" } (liveness, aucune dépendance DB)', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' })
  })

  it('GET /health/ready returns 200 with the database check up', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.details.database.status).toBe('up')
  })
})
