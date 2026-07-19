import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'

describe('/health/ready with Redis (e2e)', () => {
  let db: TestDb
  let redis: TestRedis
  let app: INestApplication

  beforeAll(async () => {
    ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
    app = await createTestApp(db.appUrl, { host: redis.host, port: redis.port })
  })
  afterAll(async () => {
    await app.close()
    await Promise.all([db.stop(), redis.stop()])
  })

  // Contrat enrichi (Task 9, spec §6) — cf. health.e2e.test.ts pour la
  // couverture exhaustive (down/degraded/503, aucune fuite de détail) : ce
  // fichier (Task 2.1-1, readiness Redis) ne vérifie que le cas nominal.
  it('reports database AND redis up', async () => {
    const res = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.db.ok).toBe(true)
    expect(res.body.redis.ok).toBe(true)
  })

  it('liveness stays trivial (no dependency)', async () => {
    await request(app.getHttpServer()).get('/health').expect(200)
  })
})
