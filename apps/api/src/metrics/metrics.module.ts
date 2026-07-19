import { Global, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { QueueModule } from '../queue/queue.module.js'
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js'
import { MetricsController } from './metrics.controller.js'
import { MetricsService } from './metrics.service.js'
import { PgPoolMetricsService } from './pg-pool-metrics.service.js'
import { QueueMetricsService } from './queue-metrics.service.js'

// @Global (Task 8, plan phase 5 it.2) : `MetricsService` sera injecté par
// des modules qui n'ont aucune raison d'importer `MetricsModule` autrement
// (billing, worker — Task 9, pour poser leurs propres compteurs/jauges via
// `registerCollector`), motif `BillingPortModule`.
//
// L'interceptor HTTP est enregistré ICI en `APP_INTERCEPTOR` (portée
// globale : s'applique à toutes les routes de l'app), pas dans
// `app.module.ts` — motif `AuthModule`, qui pose `ThrottlerGuard` en
// `APP_GUARD` depuis son propre module plutôt que d'exposer un `providers`
// brut sur `AppModule` (lequel reste un pur agrégateur d'imports). Nest
// résout les tokens `APP_*` globalement quel que soit le module qui les
// déclare, du moment qu'il fait partie de l'arbre — importer
// `MetricsModule` dans `app.module.ts` suffit à câbler l'interceptor.
// QueueModule (Task 9, spec §6) : requis pour QueueMetricsService, qui
// injecte via `@InjectQueue` les 5 files de l'allowlist (queue.constants.ts),
// motif AdminModule/HealthModule (chacun importe QueueModule directement
// pour la même raison — classe statique, Nest la dé-duplique dans le graphe
// quel que soit le nombre de parents qui l'importent, aucune re-instanciation
// de `BullModule.forRootAsync`). APP_POOL (PgPoolMetricsService) N'EST PAS
// importé explicitement ici : fourni par DbModule, `@Global` (même
// convention que tout autre repository du projet) — mais CE global n'existe
// que dans les graphes qui montent réellement DbModule (AppModule complet) ;
// un test qui monte MetricsModule seul (motif metrics.e2e.test.ts, describe
// "token absent") doit fournir son propre provider APP_POOL factice.
@Global()
@Module({
  imports: [QueueModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    QueueMetricsService,
    PgPoolMetricsService,
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
