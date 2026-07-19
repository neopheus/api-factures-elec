import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { Gauge } from 'prom-client'
import {
  ANNUAIRE_SYNC_QUEUE,
  CDV_TRANSMISSION_QUEUE,
  EREPORTING_GENERATION_QUEUE,
  INVOICE_GENERATION_QUEUE,
  MAINTENANCE_QUEUE,
} from '../queue/queue.constants.js'
import { MetricsService } from './metrics.service.js'

// États exposés (spec §6, brief Task 9) : demandés EXPLICITEMENT à
// `getJobCounts()` (jamais l'appel sans argument, qui renvoie aussi
// paused/prioritized/waiting-children — hors contrat de cette jauge).
const STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const

// Jauges BullMQ (Task 9, spec §6) — motif AdminJobsService : allowlist
// STRICTE = EXACTEMENT les 5 files de queue.constants.ts, matérialisée en Map
// figée nom public -> Queue injectée (construite une seule fois au
// constructeur). Le Gauge `bullmq_jobs{queue,state}` est enregistré sur le
// registre DÉDIÉ de MetricsService injecté (jamais le register global
// prom-client, cf. metrics.service.ts) et rafraîchi via `registerCollector`
// : la collecte a lieu AU SCRAPE (`queue.getJobCounts()`), jamais par un
// polling en arrière-plan qui ferait tourner du code même quand personne ne
// scrape.
@Injectable()
export class QueueMetricsService implements OnModuleInit {
  private readonly logger = new Logger(QueueMetricsService.name)
  private readonly gauge: Gauge<'queue' | 'state'>
  private readonly queues: ReadonlyMap<string, Queue>

  // @Inject() explicite sur MetricsService (motif BillingGuard/ApiKeyGuard) :
  // sans lui, SWC émet un ternaire design:paramtypes dont la branche "false"
  // n'est atteignable qu'en cas d'import circulaire cassé — structurellement
  // impossible ici, jamais couvrable par un test.
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @InjectQueue(INVOICE_GENERATION_QUEUE) invoiceGeneration: Queue,
    @InjectQueue(MAINTENANCE_QUEUE) maintenance: Queue,
    @InjectQueue(EREPORTING_GENERATION_QUEUE) ereportingGeneration: Queue,
    @InjectQueue(ANNUAIRE_SYNC_QUEUE) annuaireSync: Queue,
    @InjectQueue(CDV_TRANSMISSION_QUEUE) cdvTransmission: Queue,
  ) {
    this.queues = new Map<string, Queue>([
      [INVOICE_GENERATION_QUEUE, invoiceGeneration],
      [MAINTENANCE_QUEUE, maintenance],
      [EREPORTING_GENERATION_QUEUE, ereportingGeneration],
      [ANNUAIRE_SYNC_QUEUE, annuaireSync],
      [CDV_TRANSMISSION_QUEUE, cdvTransmission],
    ])
    this.gauge = new Gauge({
      name: 'bullmq_jobs',
      help: 'Nombre de jobs BullMQ par file et par état, collecté au scrape',
      labelNames: ['queue', 'state'],
      registers: [metrics.registry],
    })
  }

  // Câblage au démarrage du module (motif MetricsModule) : la collecte
  // elle-même ne s'exécute jamais ici, seulement l'ENREGISTREMENT du
  // collector — `MetricsService.render()` l'invoquera à chaque scrape.
  onModuleInit(): void {
    this.metrics.registerCollector(() => this.collect())
  }

  async collect(): Promise<void> {
    // Isolation PAR FILE (motif MetricsService.render/AdminJobsService.
    // retryFailed) : une file dont le Redis est injoignable ne doit JAMAIS
    // empêcher la collecte des 4 autres — `MetricsService.render()` isole
    // déjà ce collector dans son ENSEMBLE (un throw ici serait absorbé au
    // niveau du collector complet, mais ferait perdre TOUTES les files) ;
    // l'isolation ICI, par file, est plus fine.
    for (const [name, queue] of this.queues) {
      try {
        const counts = await queue.getJobCounts(...STATES)
        for (const state of STATES) {
          this.gauge.set({ queue: name, state }, counts[state] ?? 0)
        }
      } catch (err) {
        this.logger.warn(
          `getJobCounts en échec pour la file "${name}", ignorée pour ce scrape : ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }
}
