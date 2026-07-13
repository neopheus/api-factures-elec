// Effet de bord OBLIGATOIRE en première position (cf. helpers/rate-limit-env.ts) :
// pose la limite basse avant que l'import de `./helpers/app.js` ci-dessous ne
// charge (transitivement) AppModule/ConfigModule, qui valide process.env de
// façon eager. La poser dans un beforeAll serait trop tard.
import './helpers/rate-limit-env.js'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'

describe('rate limiting (e2e)', () => {
  let db: TestDb
  let app: INestApplication

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl)
  })
  afterAll(async () => {
    await app.close()
    await db.stop()
    delete process.env.RATE_LIMIT_LIMIT
    delete process.env.RATE_LIMIT_TTL
  })

  it('returns 429 problem+json past the configured limit on a real (unguarded) endpoint', async () => {
    // /health n'exige pas de clé API : le ThrottlerGuard global (par IP,
    // en amont de l'auth) s'applique quand même. supertest partage l'IP
    // loopback entre requêtes.
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await request(app.getHttpServer()).get('/health')
      statuses.push(res.status)
    }
    expect(statuses).toEqual([200, 200, 200, 429])

    const res = await request(app.getHttpServer()).get('/health')
    expect(res.status).toBe(429)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:rate-limited')
  })
})
