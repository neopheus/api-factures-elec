import { Writable } from 'node:stream'
import {
  Controller,
  Get,
  type INestApplication,
  Module,
  UseGuards,
} from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Logger, LoggerModule } from 'nestjs-pino'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiKeyGuard } from '../../src/auth/api-key.guard.js'
import { ApiKeyService } from '../../src/auth/api-key.service.js'
import { CurrentTenant } from '../../src/auth/current-tenant.decorator.js'
import { AppConfigModule } from '../../src/config/config.module.js'
import { APP_POOL, createPool } from '../../src/db/client.js'
import { DbModule } from '../../src/db/db.module.js'
import { buildPinoHttpOptions } from '../../src/logging/logger.module.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

@Controller('whoami')
class WhoamiController {
  @UseGuards(ApiKeyGuard)
  @Get()
  whoami(@CurrentTenant() tenantId: string): { tenantId: string } {
    return { tenantId }
  }
}

// Déviation par rapport au code exact du brief : le brief ne déclare que
// `providers: [ApiKeyService, ApiKeyGuard]`, sans APP_POOL nulle part dans le
// graphe — `.overrideProvider(APP_POOL)` (ci-dessous) n'a alors rien à
// substituer (Nest : « make sure APP_POOL is available in the WhoamiModule
// module »). On importe AppConfigModule (nécessaire à ConfigService, injecté
// par DbModule) + DbModule (déclare réellement APP_POOL, @Global()) pour que
// l'override ait un provider existant à remplacer — même mécanique que
// `createTestApp` pour l'app complète (Task 5).
@Module({
  imports: [AppConfigModule, DbModule],
  controllers: [WhoamiController],
  providers: [ApiKeyService, ApiKeyGuard],
})
class WhoamiModule {}

describe('ApiKeyGuard (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  let tenantId: string

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token, tenantId } = await seedTenantWithKey(ownerPool))
    const mod = await Test.createTestingModule({ imports: [WhoamiModule] })
      .overrideProvider(APP_POOL)
      .useFactory({ factory: () => createPool(db.appUrl) })
      .compile()
    app = mod.createNestApplication()
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('rejects a request without a key (401 problem+json)', async () => {
    const res = await request(app.getHttpServer()).get('/whoami')
    expect(res.status).toBe(401)
    expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
  })

  it('rejects a malformed scheme, not "Bearer ..." (401)', async () => {
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', 'Basic dXNlcjpwYXNz')
      .expect(401)
  })

  it('rejects a syntactically malformed token — fails parseApiKeyToken, no prefix to look up (401)', async () => {
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', 'Bearer not-a-valid-token')
      .expect(401)
  })

  it('rejects an unknown prefix (401)', async () => {
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', 'Bearer fk_deadbeef.invalid')
      .expect(401)
  })

  it('rejects a known, active prefix with the wrong secret (401)', async () => {
    const dot = token.indexOf('.')
    const wrongToken = `${token.slice(0, dot)}.wrong-secret-value`
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${wrongToken}`)
      .expect(401)
  })

  it('accepts a valid key and resolves the tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
    expect(res.body.tenantId).toBe(tenantId)
  })

  it('accepts a lowercase "bearer" scheme (RFC 7235 : case-insensitive)', async () => {
    const res = await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `bearer ${token}`)
      .expect(200)
    expect(res.body.tenantId).toBe(tenantId)
  })

  it('rejects a revoked key (401)', async () => {
    const { token: revoked } = await seedTenantWithKey(ownerPool, 'Revoked')
    const prefix = revoked.slice(3, revoked.indexOf('.'))
    await ownerPool.query(
      'UPDATE api_keys SET revoked_at = now() WHERE prefix = $1',
      [prefix],
    )
    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${revoked}`)
      .expect(401)
  })
})

// Ajout (au-delà du brief) : verrou anti-fuite du secret dans les logs. Monte
// une app séparée avec un vrai pipeline pino (niveau 'info', pas 'silent')
// écrivant vers un flux capturable — exactement le pattern main.ts
// (`app.useLogger(app.get(Logger))`) — pour prouver, sur le flux HTTP réel
// (pino-http/autoLogging), qu'aucune tentative d'authentification échouée
// (secret erroné ou préfixe inconnu) ne laisse le secret apparaître dans un
// log. La redaction générique de `req.headers.authorization` est déjà
// verrouillée par tests/unit/logger-redaction.test.ts ; ce test-ci verrouille
// le comportement de bout en bout via l'ApiKeyGuard réel.
describe('ApiKeyGuard — no secret leak in logs (e2e)', () => {
  let db: TestDb
  let ownerPool: pg.Pool
  let app: INestApplication
  let token: string
  let chunks: string[]

  beforeAll(async () => {
    db = await startTestDb()
    ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
    ;({ token } = await seedTenantWithKey(ownerPool))
    chunks = []
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString())
        cb()
      },
    })
    const mod = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DbModule,
        LoggerModule.forRoot({
          pinoHttp: { ...buildPinoHttpOptions('info'), stream },
        }),
      ],
      controllers: [WhoamiController],
      providers: [ApiKeyService, ApiKeyGuard],
    })
      .overrideProvider(APP_POOL)
      .useFactory({ factory: () => createPool(db.appUrl) })
      .compile()
    app = mod.createNestApplication({ bufferLogs: true })
    app.useLogger(app.get(Logger))
    await app.init()
  })
  afterAll(async () => {
    await app.close()
    await ownerPool.end()
    await db.stop()
  })

  it('never logs the secret on a failed auth attempt (bad secret on a known prefix)', async () => {
    chunks.length = 0
    const dot = token.indexOf('.')
    const realSecret = token.slice(dot + 1)
    const wrongToken = `${token.slice(0, dot)}.wrong-secret-value`

    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${wrongToken}`)
      .expect(401)

    const out = chunks.join('')
    expect(out.length).toBeGreaterThan(0) // sanity : la requête a bien été loguée
    expect(out).not.toContain('wrong-secret-value')
    expect(out).not.toContain(realSecret)
  })

  it('never logs the secret on a successful auth attempt either', async () => {
    chunks.length = 0
    const realSecret = token.slice(token.indexOf('.') + 1)

    await request(app.getHttpServer())
      .get('/whoami')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)

    const out = chunks.join('')
    expect(out.length).toBeGreaterThan(0)
    expect(out).not.toContain(realSecret)
  })
})
