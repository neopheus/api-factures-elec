// Effet de bord OBLIGATOIRE en première position (cf.
// helpers/metrics-token-env.ts) : pose METRICS_TOKEN avant que l'import de
// `./helpers/app.js` ci-dessous ne charge (transitivement) AppModule/
// ConfigModule, qui valide process.env de façon eager. Ne concerne QUE le
// describe « token présent » (app complète) — le describe « token absent »
// monte un module Nest minimal avec `skipProcessEnv: true`, totalement
// hermétique à cette valeur (cf. commentaire dans ce describe).
import './helpers/metrics-token-env.js'
import type { INestApplication } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProblemDetailsFilter } from '../../src/common/http-exception.filter.js'
import { MetricsModule } from '../../src/metrics/metrics.module.js'
import { createTestApp, listenOnce } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { seedTenantWithKey } from './helpers/seed.js'

const METRICS_TOKEN = 'e2e-metrics-token-1234567890'

describe('GET /metrics (e2e light)', () => {
  describe('METRICS_TOKEN absent de l’env (route opt-in désactivée)', () => {
    let app: INestApplication

    beforeAll(async () => {
      // Module Nest MINIMAL (motif security-headers.e2e.test.ts), pas
      // AppModule : dans CE fichier, AppModule verrait toujours
      // METRICS_TOKEN posé par metrics-token-env.ts (une seule validation
      // process.env par fichier/graphe de modules chargé, motif
      // rate-limit-env.ts/billing-fake-env.ts) — impossible de tester
      // « absent » à travers lui. `skipProcessEnv: true` + `validate: () =>
      // ({})` : ConfigService ignore délibérément process.env ET tout
      // fichier .env, METRICS_TOKEN est donc STRICTEMENT undefined ici, quel
      // que soit l'environnement réel du process de test.
      const mod = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            skipProcessEnv: true,
            validate: () => ({}),
          }),
          MetricsModule,
        ],
      }).compile()
      app = mod.createNestApplication()
      app.useGlobalFilters(new ProblemDetailsFilter())
      await app.init()
      await listenOnce(app)
    })
    afterAll(async () => {
      await app.close()
    })

    it('404 — même FORME que le 404 global d’une route réellement inexistante (indiscernable)', async () => {
      const scrape = await request(app.getHttpServer()).get('/metrics')
      const missing = await request(app.getHttpServer()).get(
        '/this-route-does-not-exist',
      )

      expect(scrape.status).toBe(404)
      expect(scrape.headers['content-type']).toContain(
        'application/problem+json',
      )
      expect(scrape.body).toEqual({
        type: 'urn:factelec:problem:not-found',
        title: 'Not Found',
        status: 404,
        detail: 'Cannot GET /metrics',
      })
      // Même mécanisme (`ProblemDetailsFilter` sur un `NotFoundException`) :
      // type/title/status identiques à une route qui n'existe RÉELLEMENT
      // pas, mêmes clés — seul `detail` diffère (il embarque le chemin
      // demandé, comme le 404 global lui-même).
      expect(missing.status).toBe(404)
      expect(missing.body.type).toBe(scrape.body.type)
      expect(missing.body.title).toBe(scrape.body.title)
      expect(Object.keys(missing.body).sort()).toEqual(
        Object.keys(scrape.body).sort(),
      )
    })

    it('même avec un Authorization Bearer présent → reste 404 (opt-in par absence d’env, pas par absence d’en-tête)', async () => {
      const res = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)
      expect(res.status).toBe(404)
    })
  })

  describe('METRICS_TOKEN présent (scrape protégé, app complète)', () => {
    let db: TestDb
    let ownerPool: pg.Pool
    let app: INestApplication
    let apiKeyToken: string

    beforeAll(async () => {
      db = await startTestDb()
      ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
      ;({ token: apiKeyToken } = await seedTenantWithKey(ownerPool))
      app = await createTestApp(db.appUrl)
    })
    afterAll(async () => {
      await app.close()
      await ownerPool.end()
      await db.stop()
    })

    it('token faux → 401 problem générique', async () => {
      const res = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token')
      expect(res.status).toBe(401)
      expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
    })

    it('en-tête Authorization absent → 401 (même problem, pas d’oracle)', async () => {
      const res = await request(app.getHttpServer()).get('/metrics')
      expect(res.status).toBe(401)
      expect(res.body.type).toBe('urn:factelec:problem:unauthorized')
    })

    it('bon token → 200 text/plain, histogramme HTTP présent, route normalisée (aucune URL brute avec UUID)', async () => {
      const unknownId = '22222222-2222-2222-2222-222222222222'
      // Exerce une route paramétrée AVANT le scrape : passe TenantAuthGuard
      // (clé API valide, motif read.e2e.test.ts) puis échoue en 404
      // MÉTIER (facture inconnue) — observé par l'interceptor via
      // `catchError` (pas un rejet de guard, qui échapperait à l'interceptor).
      await request(app.getHttpServer())
        .get(`/invoices/${unknownId}`)
        .set('Authorization', `Bearer ${apiKeyToken}`)
        .expect(404)

      const res = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/plain')
      expect(res.text).toContain('http_request_duration_seconds')
      // Route NORMALISÉE (pattern Express `:id`), jamais l'URL brute :
      // cardinalité bornée par le nombre de routes déclarées, pas par le
      // nombre d'identifiants distincts vus en prod.
      expect(res.text).toMatch(/route="\/invoices\/:id"/)
      expect(res.text).not.toContain(unknownId)
    })
  })
})
