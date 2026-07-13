import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

@Controller('ping')
class PingController {
  @Get()
  ping(): { status: 'ok' } {
    return { status: 'ok' }
  }
}

// Reproduit le câblage CORS de main.ts (allowlist stricte, pas de credentials)
// sans dépendre de la config globale.
describe('CORS allowlist (e2e)', () => {
  let app: INestApplication
  const allowedOrigins = ['http://a.example']

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [PingController],
    }).compile()
    app = mod.createNestApplication()
    app.enableCors({
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
      credentials: false,
    })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('reflects an allowed origin in Access-Control-Allow-Origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/ping')
      .set('Origin', 'http://a.example')

    expect(res.headers['access-control-allow-origin']).toBe('http://a.example')
  })

  it('does not grant CORS access to a non-allowlisted origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/ping')
      .set('Origin', 'http://evil.example')

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('never sets Access-Control-Allow-Credentials (credentials: false)', async () => {
    const res = await request(app.getHttpServer())
      .get('/ping')
      .set('Origin', 'http://a.example')

    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })
})
