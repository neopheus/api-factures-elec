import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { InjectQueue } from '@nestjs/bullmq'
import { Controller, Get, Inject, Logger, Res } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'
import type { Queue } from 'bullmq'
import type { Response } from 'express'
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

// Même borne pour les checks DB (SELECT 1 ET comptage des migrations) : le
// pool `pg` (`db/client.ts#createPool`) ne pose aucun `connectionTimeoutMillis`
// (utile aux connexions applicatives normales, qui ne doivent pas expirer
// sous charge) — contre un hôte injoignable qui NE REFUSE PAS la connexion
// (paquets silencieusement perdus, plutôt qu'un ECONNREFUSED immédiat), le
// handshake TCP peut se bloquer plusieurs dizaines de secondes avant que le
// noyau n'abandonne. Même motif que REDIS_PING_TIMEOUT_MS ci-dessus : borner
// uniquement la RÉPONSE de la sonde, jamais la politique de connexion du pool
// partagé.
const DB_PING_TIMEOUT_MS = 2_000

// Journal drizzle-kit (nombre de migrations ATTENDUES) — résolu relativement
// à CE fichier : `src/health/` et `dist/health/` (swc --out-dir dist
// --strip-leading-paths, cf. package.json `build`, qui copie ÉGALEMENT
// `src/db/migrations` vers `dist/db/migrations` pour préserver ce même
// miroir 1:1) sont à la MÊME profondeur sous `src/db/migrations/meta/` que
// leur pendant `dist/` — donc le même nombre de remontées `..` résout le
// même chemin en dev (tsx, depuis src/), en test (vitest+swc, depuis src/)
// ET en prod (depuis dist/). Motif ereporting-xsd-validator.ts (même
// résolution `import.meta.dirname` + mirroring src/dist).
const JOURNAL_PATH = resolve(
  import.meta.dirname,
  '../db/migrations/meta/_journal.json',
)

interface ComponentStatus {
  ok: boolean
  latencyMs: number
}

interface ReadinessBody {
  status: 'ok' | 'degraded'
  db: ComponentStatus
  redis: ComponentStatus
  migrations: { ok: boolean }
}

// Les probes liveness/readiness sont interrogées par l'orchestrateur
// (Kubernetes, ELB, etc.) à haute fréquence et ne doivent JAMAIS être
// soumises au rate limiting global (`ThrottlerGuard`, `APP_GUARD`) : un 429
// sur `/health` ferait passer un service sain pour indisponible.
@SkipThrottle()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  // Nombre de migrations ATTENDUES (entrées du journal drizzle-kit), lu UNE
  // FOIS au démarrage (motif BillingGuard/MetricsController : config figée,
  // jamais réévaluée par requête) — le journal est un artefact de build
  // IMMUABLE, le relire à chaque requête serait un accès disque inutile sur
  // une sonde interrogée en boucle. Un journal illisible/absent est un
  // défaut de PACKAGING (dist non aligné avec src) — on préfère planter tôt
  // au démarrage (motif SessionPurgeScheduler : « échouer tôt ») plutôt que
  // de faire tourner un healthcheck structurellement incapable de répondre
  // juste.
  private readonly expectedMigrationsCount: number

  constructor(
    @Inject(APP_POOL) private readonly pool: pg.Pool,
    @InjectQueue(INVOICE_GENERATION_QUEUE) private readonly queue: Queue,
  ) {
    const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8')) as {
      entries: unknown[]
    }
    this.expectedMigrationsCount = journal.entries.length
  }

  @Get()
  liveness(): { status: 'ok' } {
    return { status: 'ok' }
  }

  // Healthcheck enrichi (Task 9, spec §6) : réponse PUBLIQUE bornée — statuts
  // booléens + latences SEULEMENT, jamais un message d'erreur brut (pas de
  // fuite de détail interne). Un composant down → HTTP 503 + status
  // 'degraded', les AUTRES champs restent renseignés (contrat DIFFÉRENT de
  // l'ancienne implémentation terminus, qui reformattait tout rejet en
  // application/problem+json générique via ProblemDetailsFilter, masquant la
  // structure enrichie). Le corps de réponse est donc écrit directement via
  // `@Res()` (motif MetricsController.scrape) plutôt que par une exception —
  // aucune exception n'est levée ici, JAMAIS.
  @Get('ready')
  async readiness(@Res() res: Response): Promise<void> {
    const [db, redis, migrations] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkMigrations(),
    ])
    const healthy = db.ok && redis.ok && migrations.ok
    const body: ReadinessBody = {
      status: healthy ? 'ok' : 'degraded',
      db,
      redis,
      migrations,
    }
    res.status(healthy ? 200 : 503).json(body)
  }

  private async checkDb(): Promise<ComponentStatus> {
    const start = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const queryPromise = this.pool.query('SELECT 1')
      // Absorbe un rejet tardif si la requête perd la course ci-dessous
      // (connexion qui échoue seulement après le timeout) : sans ce
      // `.catch`, ce serait un rejet non géré au niveau du process.
      queryPromise.catch(() => undefined)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('database query timeout')),
          DB_PING_TIMEOUT_MS,
        )
      })
      await Promise.race([queryPromise, timeout])
      return { ok: true, latencyMs: Math.round(performance.now() - start) }
    } catch (err) {
      this.logger.warn(
        `healthcheck DB en échec : ${err instanceof Error ? err.message : String(err)}`,
      )
      return { ok: false, latencyMs: Math.round(performance.now() - start) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async checkRedis(): Promise<ComponentStatus> {
    const start = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // queue.client est une Promise<RedisClient> (= IRedisClient, façade
      // BullMQ 5.80.9 devant ioredis/node-redis/Bun). `ping` n'est PAS
      // déclarée sur cette interface adapter (seules les commandes que
      // BullMQ utilise en interne le sont) mais reste forwardée telle quelle
      // par le proxy vers le client ioredis réel sous-jacent — l'assertion
      // ci-dessous ne change donc rien à l'exécution, elle ne fait que
      // combler ce trou de typage.
      const client = await this.queue.client
      const pingPromise = (
        client as unknown as { ping(): Promise<string> }
      ).ping()
      // Absorbe un rejet tardif (retry ioredis en arrière-plan) : même motif
      // que checkDb ci-dessus.
      pingPromise.catch(() => undefined)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('redis ping timeout')),
          REDIS_PING_TIMEOUT_MS,
        )
      })
      const pong = await Promise.race([pingPromise, timeout])
      return {
        ok: pong === 'PONG',
        latencyMs: Math.round(performance.now() - start),
      }
    } catch (err) {
      this.logger.warn(
        `healthcheck Redis en échec : ${err instanceof Error ? err.message : String(err)}`,
      )
      return { ok: false, latencyMs: Math.round(performance.now() - start) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async checkMigrations(): Promise<{ ok: boolean }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const queryPromise = this.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
      )
      queryPromise.catch(() => undefined)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('migrations count query timeout')),
          DB_PING_TIMEOUT_MS,
        )
      })
      const result = await Promise.race([queryPromise, timeout])
      const applied = Number(result.rows[0]?.count)
      return { ok: applied === this.expectedMigrationsCount }
    } catch (err) {
      this.logger.warn(
        `healthcheck migrations en échec : ${err instanceof Error ? err.message : String(err)}`,
      )
      return { ok: false }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
