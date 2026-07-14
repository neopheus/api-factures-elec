import { InjectQueue } from '@nestjs/bullmq'
import { Controller, Get, Inject } from '@nestjs/common'
// biome-ignore lint/style/useImportType: HealthCheckService résolu par Nest via design:paramtypes.
import {
  HealthCheck,
  HealthCheckError,
  HealthCheckService,
} from '@nestjs/terminus'
import { SkipThrottle } from '@nestjs/throttler'
import type { Queue } from 'bullmq'
import type pg from 'pg'
import { APP_POOL } from '../db/client.js'
import { INVOICE_GENERATION_QUEUE } from '../queue/queue.constants.js'

// Borne le ping Redis de la sonde readiness. Vérifié empiriquement : la
// stratégie de reconnexion ioredis posée par BullMQ (cf. queue.module.ts,
// `retryStrategy` par défaut) ne renonce JAMAIS d'elle-même — un `ping()`
// contre un Redis injoignable ne se résout donc JAMAIS spontanément (observé
// : 150 s dépassées sans résolution). Sans borne, `/health/ready` pendrait
// indéfiniment au lieu de renvoyer 503 rapidement — inacceptable pour une
// sonde interrogée à haute fréquence par un orchestrateur. Le ping abandonné
// continue de retenter en arrière-plan (le `.catch` no-op ci-dessous absorbe
// son rejet éventuel, potentiellement bien après la réponse HTTP) : seule la
// RÉPONSE est bornée ici, la politique de retry de la connexion partagée
// (utile aux enfilements réels, Task 2+) n'est pas modifiée.
const REDIS_PING_TIMEOUT_MS = 2_000

// Les probes liveness/readiness sont interrogées par l'orchestrateur
// (Kubernetes, ELB, etc.) à haute fréquence et ne doivent JAMAIS être
// soumises au rate limiting global (`ThrottlerGuard`, `APP_GUARD`) : un 429
// sur `/health` ferait passer un service sain pour indisponible.
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    @InjectQueue(INVOICE_GENERATION_QUEUE) private readonly queue: Queue,
  ) {}

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      async () => {
        await this.pool.query('SELECT 1')
        return { database: { status: 'up' } }
      },
      async () => {
        // queue.client est une Promise<RedisClient> (= IRedisClient, façade
        // BullMQ 5.80.2 devant ioredis/node-redis/Bun). `ping` n'est PAS
        // déclarée sur cette interface adapter (seules les commandes que
        // BullMQ utilise en interne le sont) mais reste forwardée telle
        // quelle par le proxy vers le client ioredis réel sous-jacent
        // (cf. createIORedisClient) : l'assertion ci-dessous ne change donc
        // rien à l'exécution, elle ne fait que combler ce trou de typage.
        // Ping échoue (ou dépasse REDIS_PING_TIMEOUT_MS) → HealthCheckError →
        // terminus marque `redis` down → 503.
        //
        // IMPORTANT : terminus (`HealthCheckExecutor.executeHealthIndicators`,
        // @nestjs/terminus 11.1.1) ne traite QUE les rejets qui sont des
        // `HealthCheckError` comme un échec « down » normal (503) — tout
        // autre type d'erreur rejetée est explicitement RE-LANCÉE telle
        // quelle (« Is not an expected error. Throw further! », lu aux
        // sources) et finit en 500 via le filtre d'exception global. Vérifié
        // empiriquement : un simple `throw new Error(...)` produisait bien
        // 500, pas 503.
        const client = await this.queue.client
        const pingPromise = (
          client as unknown as { ping(): Promise<string> }
        ).ping()
        // Absorbe un rejet tardif si le ping perd la course ci-dessous et
        // échoue seulement après coup (retry ioredis en arrière-plan) : sans
        // ce `.catch`, ce serait un rejet non géré au niveau du process.
        pingPromise.catch(() => undefined)
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('redis ping timeout')),
            REDIS_PING_TIMEOUT_MS,
          )
        })
        try {
          const pong = await Promise.race([pingPromise, timeout])
          if (pong !== 'PONG') {
            throw new HealthCheckError('redis check failed', {
              redis: {
                status: 'down',
                message: 'unexpected redis ping response',
              },
            })
          }
          return { redis: { status: 'up' } }
        } catch (err) {
          if (err instanceof HealthCheckError) throw err
          const message =
            err instanceof Error ? err.message : 'redis check failed'
          throw new HealthCheckError('redis check failed', {
            redis: { status: 'down', message },
          })
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
    ])
  }
}
