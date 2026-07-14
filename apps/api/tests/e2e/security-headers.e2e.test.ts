import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProblemDetailsFilter } from '../../src/common/http-exception.filter.js'
import { listenOnce } from './helpers/app.js'

@Controller('boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error('secret internal detail: db password xyz')
  }
}

describe('security + problem filter (e2e)', () => {
  let app: INestApplication
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [BoomController],
    }).compile()
    app = mod.createNestApplication()
    const helmet = (await import('helmet')).default
    app.use(helmet())
    app.useGlobalFilters(new ProblemDetailsFilter())
    await app.init()
    await listenOnce(app)
  })
  afterAll(async () => {
    await app.close()
  })

  it('sets helmet security headers', async () => {
    const res = await request(app.getHttpServer()).get('/boom')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('never leaks internal error details (generic 500 problem+json)', async () => {
    const res = await request(app.getHttpServer()).get('/boom')
    expect(res.status).toBe(500)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.body.type).toBe('urn:factelec:problem:internal-error')
    expect(JSON.stringify(res.body)).not.toContain('db password')
  })
})
