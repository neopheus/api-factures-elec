import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import type { Queue } from 'bullmq'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../../src/queue/queue.constants.js'
import { createTestApp } from './helpers/app.js'
import { startTestDb, type TestDb } from './helpers/postgres.js'
import { startTestRedis, type TestRedis } from './helpers/redis.js'

// Amendement A4 : depuis que HealthController dépend de APP_POOL (readiness DB,
// Task 5), monter HealthModule seul ne compile plus (APP_POOL non fourni). On
// bascule sur le helper createTestApp — app complète + Postgres réel, pas de mock.
//
// Depuis Task 2.1-1 (QueueModule), la readiness inclut aussi Redis : un Redis
// de test réel est requis ici, sinon `/health/ready` renverrait 503 (ping
// Redis en échec, cf. health.controller.ts).
//
// Task 9 (spec §6) : contrat ENRICHI — `{ status, db: {ok,latencyMs},
// redis: {ok,latencyMs}, migrations: {ok} }`, réponse écrite directement
// (plus via terminus/ProblemDetailsFilter) : 200 si tout est sain, 503 sinon,
// le CORPS reste la même forme enrichie dans les deux cas (jamais un
// problem+json générique pour CETTE route).
describe('health (e2e)', () => {
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

  it('GET /health returns 200 { status: "ok" } (liveness, aucune dépendance DB)', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' })
  })

  it('GET /health/ready returns 200, db/redis.ok=true avec des latencyMs numériques, migrations.ok=true (journal appliqué au complet par startTestDb)', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      status: 'ok',
      db: { ok: true, latencyMs: expect.any(Number) },
      redis: { ok: true, latencyMs: expect.any(Number) },
      migrations: { ok: true },
    })
  })
})

// Cas « down » : Redis injoignable. `127.0.0.1:1` (port réservé, jamais
// attribuable sans privilèges) plutôt qu'un conteneur démarré-puis-arrêté :
// plus déterministe (aucune dépendance au délai réel de teardown Docker sous
// charge concurrente — un arrêt de conteneur lent avait rendu ce test
// intermittent lorsqu'il tournait en parallèle d'un autre fichier e2e) et
// sans coût de conteneur supplémentaire.
describe('health (e2e) — Redis down', () => {
  let db: TestDb
  let app: INestApplication

  beforeAll(async () => {
    db = await startTestDb()
    app = await createTestApp(db.appUrl, { host: '127.0.0.1', port: 1 })
  })

  afterAll(async () => {
    // Redis est injoignable : `Queue.close()` (invoqué par NestJS via
    // `app.close()`) attend par défaut un `QUIT` gracieux
    // (`RedisConnection.close(force=false)` → `client.quit()`), qui
    // bloquerait indéfiniment contre un Redis mort. On force la déconnexion
    // de CHAQUE file AVANT de fermer l'app, via l'API publique
    // `Queue.disconnect()` (« Force disconnects a connection », documentée
    // par bullmq). Borné par une garde de sécurité : `RedisConnection.
    // disconnect()` attend un évènement `end`/`error` de l'adapter ioredis
    // qui, vérifié empiriquement, ne survient PAS de façon fiable sous
    // exécution e2e concurrente (plusieurs fichiers Testcontainers en
    // parallèle) — sans cette garde, `afterAll` peut dépasser le hookTimeout
    // global (150 s). Best-effort : le process du worker vitest est de toute
    // façon recyclé en fin de fichier, donc une connexion résiduelle non
    // fermée proprement ICI ne fuit pas au-delà de ce fichier de test. Ceci
    // n'affecte QUE le teardown de test : en production, l'app ne se ferme
    // jamais à cause d'un health-check en échec (la connexion continue de
    // retenter en arrière-plan, résilience voulue) — seule la RÉPONSE HTTP
    // est bornée (cf. health.controller.ts, REDIS_PING_TIMEOUT_MS).
    await Promise.race([
      Promise.all(
        [INVOICE_GENERATION_QUEUE, MAINTENANCE_QUEUE].map((name) =>
          app.get<Queue>(getQueueToken(name)).disconnect(),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    await db.stop()
  })

  it('GET /health/ready fails fast (503) — not a hang — when Redis is unreachable ; db/migrations restent renseignés et à true, aucune fuite de message', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready')

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('degraded')
    expect(res.body.redis.ok).toBe(false)
    expect(typeof res.body.redis.latencyMs).toBe('number')
    expect(res.body.db).toEqual({ ok: true, latencyMs: expect.any(Number) })
    expect(res.body.migrations).toEqual({ ok: true })
    // AUCUNE fuite de détail (spec §6) : ni message d'erreur brut, ni champ
    // hors contrat (status/db/redis/migrations SEULEMENT).
    expect(Object.keys(res.body).sort()).toEqual(
      ['db', 'migrations', 'redis', 'status'].sort(),
    )
  }, 10_000)

  it('GET /health stays trivial (liveness, aucune dépendance Redis)', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' })
  })
})

// Cas « down » : DB injoignable (mandat contrôleur Task 1 → dette reportée à
// Task 7). Même motif que le cas Redis ci-dessus (`127.0.0.1:1`, port
// réservé jamais attribuable → ECONNREFUSED rapide et déterministe). Un
// Redis de test réel est démarré et branché pour isoler la panne : sans
// override Redis, le check Redis échouerait aussi (contre le Redis par
// défaut localhost:6379, absent en CI) et masquerait ce qu'on veut vérifier
// ici — que le check DB (et migrations, qui dépend AUSSI du pool), seuls en
// échec, produisent bien 503 (pas 500).
describe('health (e2e) — DB down', () => {
  let redis: TestRedis
  let app: INestApplication

  beforeAll(async () => {
    redis = await startTestRedis()
    app = await createTestApp(
      'postgres://factelec_app:app_pw@127.0.0.1:1/factelec',
      {
        host: redis.host,
        port: redis.port,
      },
    )
  })

  afterAll(async () => {
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ])
    await redis.stop()
  })

  it('GET /health/ready fails fast (503) — not a hang, not a 500 — when the DB is unreachable ; migrations.ok bascule aussi à false (même pool), redis reste vrai', async () => {
    const res = await request(app.getHttpServer()).get('/health/ready')

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('degraded')
    expect(res.body.db.ok).toBe(false)
    expect(typeof res.body.db.latencyMs).toBe('number')
    expect(res.body.migrations).toEqual({ ok: false })
    expect(res.body.redis).toEqual({ ok: true, latencyMs: expect.any(Number) })
  }, 10_000)

  it('GET /health stays trivial (liveness, aucune dépendance DB)', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' })
  })
})
