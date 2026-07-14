import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenOnce } from './helpers/app.js'

@Controller('ping')
class PingController {
  @Get()
  ping(): { status: 'ok' } {
    return { status: 'ok' }
  }
}

// Reproduit le câblage CORS de main.ts (allowlist stricte, credentials activés
// pour le cookie de session cross-subdomain — Task 4) sans dépendre de la
// config globale.
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
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
      credentials: true,
    })
    await app.init()
    await listenOnce(app)
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

  it('sets Access-Control-Allow-Credentials: true (cookies de session cross-subdomain)', async () => {
    const res = await request(app.getHttpServer())
      .get('/ping')
      .set('Origin', 'http://a.example')

    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('allows DELETE (logout) and the X-CSRF-Token header on preflight', async () => {
    const res = await request(app.getHttpServer())
      .options('/ping')
      .set('Origin', 'http://a.example')
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token')

    expect(res.headers['access-control-allow-methods']).toContain('DELETE')
    expect(res.headers['access-control-allow-headers']).toContain(
      'X-CSRF-Token',
    )
  })
})
