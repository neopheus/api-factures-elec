import { Injectable, Logger } from '@nestjs/common'
import { Histogram, Registry } from 'prom-client'

// Un collector est appelé JUSTE AVANT la sérialisation (cf. `render()`) : il
// met à jour des métriques déjà enregistrées sur CE registre (ex: une jauge
// `gauge.set(...)`) à partir d'un état interrogé « à la demande » (ex:
// `queue.getJobCounts()`, `pool.totalCount`) — motif préféré à un
// rafraîchissement en continu en arrière-plan, qui ferait tourner du code
// même quand personne ne scrape.
export type MetricsCollector = () => Promise<void>

// Registre prom-client DÉDIÉ (Task 8, plan phase 5 it.2, spec §6) — jamais
// `prom-client`'s `register` global : plusieurs instances de `MetricsService`
// coexistent dans le même process durant les tests (chaque fichier e2e
// démarre/arrête sa propre app Nest, en parallèle dans le même worker
// vitest) — un registre process-global ferait échouer le 2ᵉ `new
// Histogram({name: 'http_request_duration_seconds', ...})` avec « metric
// already registered » et ferait fuiter les observations d'un test dans un
// autre. Chaque instance de `MetricsService` a donc son propre `Registry()`
// isolé.
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name)

  readonly registry = new Registry()

  // Buckets par défaut de prom-client (pas de surcharge, spec §6/brief
  // Task 8) : suffisants pour une API HTTP synchrone à ce stade — un
  // affinage éventuel des buckets est une évolution ultérieure, pas un
  // prérequis de cette tâche.
  readonly httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Durée des requêtes HTTP en secondes, par méthode/route normalisée/statut',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  })

  private readonly collectors: MetricsCollector[] = []

  get contentType(): string {
    return this.registry.contentType
  }

  // Point d'extension (Task 9+ : jauges BullMQ, compteurs billing, pool pg —
  // cf. brief) : billing/worker enregistrent leur collector via ce service
  // injecté (`MetricsModule` est `@Global`), sans que ce module ait besoin
  // de connaître ces domaines.
  registerCollector(fn: MetricsCollector): void {
    this.collectors.push(fn)
  }

  async render(): Promise<string> {
    // Isolation PAR COLLECTOR (motif HealthController : borner l'échec,
    // jamais le laisser se propager) : un collector qui throw (ex: Redis
    // injoignable pour les jauges BullMQ) ne doit JAMAIS faire échouer tout
    // le scrape /metrics — les métriques déjà enregistrées (HTTP, process)
    // restent exploitables par Prometheus. Séquentiel (pas de
    // `Promise.all`) : évite que plusieurs collectors en échec simultané
    // n'interlacent leurs logs de façon illisible ; le coût n'est pas
    // sensible ici (quelques collectors, scrape peu fréquent).
    for (const collector of this.collectors) {
      try {
        await collector()
      } catch (err) {
        this.logger.warn(
          `collector de métriques en échec, ignoré pour ce scrape : ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    return this.registry.metrics()
  }
}
