// Effet de bord OBLIGATOIRE en première position (cf. helpers/rate-limit-env.ts) :
// pose la limite basse avant que l'import de `./helpers/app.js` ci-dessous ne
// charge (transitivement) AppModule/ConfigModule, qui valide process.env de
// façon eager. La poser dans un beforeAll serait trop tard.
import './helpers/rate-limit-env.js'
import type { INestApplication } from '@nestjs/common'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

describe('rate limiting (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
    delete process.env.RATE_LIMIT_LIMIT
    delete process.env.RATE_LIMIT_TTL
  })

  it('returns 429 problem+json past the configured limit on a real (non-exempt) endpoint', async () => {
    // GET /invoices exige une clé API valide (ApiKeyGuard) : le
    // ThrottlerGuard global (par IP, en amont de l'auth) s'applique quand
    // même. supertest partage l'IP loopback entre requêtes.
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await request(app.getHttpServer())
        .get('/invoices')
        .set('Authorization', `Bearer ${token}`)
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])

    const res = await request(app.getHttpServer())
      .get('/invoices')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(429)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:rate-limited')
  })

  it('never rate-limits /health (liveness probe, @SkipThrottle) even well past the configured limit', async () => {
    // Limite configurée à 3 (rate-limit-env.ts) : on la dépasse largement
    // (10 requêtes) pour prouver que /health est réellement exempté, pas
    // juste "pas encore atteint la limite".
    const statuses: number[] = []
    for (let i = 0; i < 10; i++) {
      const res = await request(app.getHttpServer()).get('/health')
      statuses.push(res.status)
    }
    expect(statuses).toEqual(Array(10).fill(200))
  })
})
