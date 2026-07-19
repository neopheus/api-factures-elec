import { Global, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { HttpMetricsInterceptor } from './http-metrics.interceptor.js'
import { MetricsController } from './metrics.controller.js'
import { MetricsService } from './metrics.service.js'

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
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
