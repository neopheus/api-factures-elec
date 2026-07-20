// Effet de bord OBLIGATOIRE en première position (cf.
// helpers/metrics-token-env.ts) : pose METRICS_TOKEN avant que l'import de
// `./helpers/app.js` ci-dessous ne charge (transitivement) AppModule/
// ConfigModule, qui valide process.env de façon eager. Ne concerne QUE le
// describe « token présent » (app complète) — le describe « token absent »
// monte un module Nest minimal avec `skipProcessEnv: true`, totalement
// hermétique à cette valeur (cf. commentaire dans ce describe).
import './helpers/metrics-token-env.js'
import type { INestApplication } from '@nestjs/common'
import { Global, Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProblemDetailsFilter } from '../../src/common/http-exception.filter.js'
import { APP_POOL } from '../../src/db/client.js'
import { MetricsModule } from '../../src/metrics/metrics.module.js'
import {
  ANNUAIRE_SYNC_QUEUE,
  CDV_TRANSMISSION_QUEUE,
  EREPORTING_GENERATION_QUEUE,
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { createTestApp, listenOnce } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'
import { seedTenantWithKey } from './helpers/seed.js'

const METRICS_TOKEN = 'e2e-metrics-token-1234567890'

// APP_POOL factice, en module `@Global` DÉDIÉ (Task 9, spec §6) : un
// provider déclaré directement dans `providers` du module RACINE passé à
// `Test.createTestingModule` n'est PAS visible depuis un module IMPORTÉ (la
// résolution DI suit le graphe `imports`/`exports`, jamais l'inverse) — vérifié
// empiriquement (« Nest can't resolve dependencies … Symbol(APP_POOL) »).
// `@Global()` propage l'export à TOUT le graphe compilé pour ce test, motif
// DbModule (db/db.module.ts) lui-même. Nécessaire depuis que `MetricsModule`
// provisionne `PgPoolMetricsService` (`@Inject(APP_POOL)`) — ce describe
// (« token absent ») monte `MetricsModule` SANS jamais démarrer de Postgres
// réel ; la valeur n'est d'ailleurs jamais exercée (aucune requête de ce
// describe n'atteint /metrics avec succès, donc jamais collect()).
@Global()
@Module({
  providers: [
    {
      provide: APP_POOL,
      useValue: { totalCount: 0, idleCount: 0, waitingCount: 0 },
    },
  ],
  exports: [APP_POOL],
})
class FakeAppPoolModule {}

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
      //
      const mod = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            skipProcessEnv: true,
            validate: () => ({}),
          }),
          FakeAppPoolModule,
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
      // Fige le FORMAT du `detail` du VRAI 404 Nest (`Cannot ${method}
      // ${originalUrl}`) : si un futur bump de Nest change ce format, ce
      // garde casse ICI plutôt que de laisser /metrics dériver
      // silencieusement d'une indistinguabilité devenue fausse (revue
      // Task 8).
      expect(missing.body.detail).toBe('Cannot GET /this-route-does-not-exist')
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
    // Redis RÉEL (Testcontainers, motif health.e2e.test.ts) — requis Task 9 :
    // `QueueMetricsService.collect()` appelle `queue.getJobCounts()` sur les 5
    // files au scrape, une VRAIE commande Redis (LLEN/ZCARD), pas seulement
    // une connexion différée comme pour le reste de l'app (lazyConnect +
    // skipWaitingForReady/skipVersionCheck, cf. queue.module.ts). Reste LIGHT
    // : aucun Worker BullMQ n'est démarré, `getJobCounts()` sur des files
    // vides ne nécessite qu'un Redis JOIGNABLE, jamais un consommateur.
    let redis: TestRedis
    let ownerPool: pg.Pool
    let app: INestApplication
    let apiKeyToken: string

    beforeAll(async () => {
      ;[db, redis] = await Promise.all([startTestDb(), startTestRedis()])
      ownerPool = new pg.Pool({ connectionString: db.ownerUrl })
      ;({ token: apiKeyToken } = await seedTenantWithKey(ownerPool))
      app = await createTestApp(db.appUrl, {
        host: redis.host,
        port: redis.port,
      })
    })
    afterAll(async () => {
      await app.close()
      await ownerPool.end()
      await Promise.all([db.stop(), redis.stop()])
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

    it('bon token → jauges bullmq_jobs{queue,state} présentes pour les 5 files de l’allowlist (collecte au scrape, Redis réel sans worker)', async () => {
      const res = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)

      expect(res.status).toBe(200)
      expect(res.text).toContain('# TYPE bullmq_jobs gauge')
      for (const queue of [
        INVOICE_GENERATION_QUEUE,
        MAINTENANCE_QUEUE,
        EREPORTING_GENERATION_QUEUE,
        ANNUAIRE_SYNC_QUEUE,
        CDV_TRANSMISSION_QUEUE,
      ]) {
        // Files vides (aucun worker démarré) : état "waiting" à 0 pour
        // chacune — prouve que `getJobCounts()` a bien répondu (Redis
        // joignable), pas seulement que le collector a été enregistré.
        expect(res.text).toContain(
          `bullmq_jobs{queue="${queue}",state="waiting"} 0`,
        )
      }
    })

    it('bon token → jauge pg_pool{state} présente (total/idle/waiting), valeurs numériques cohérentes avec le pool applicatif', async () => {
      const res = await request(app.getHttpServer())
        .get('/metrics')
        .set('Authorization', `Bearer ${METRICS_TOKEN}`)

      expect(res.status).toBe(200)
      expect(res.text).toMatch(/pg_pool\{state="total"\} \d+/)
      expect(res.text).toMatch(/pg_pool\{state="idle"\} \d+/)
      expect(res.text).toMatch(/pg_pool\{state="waiting"\} \d+/)
    })
  })
})
