import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { catchError, type Observable, tap, throwError } from 'rxjs'
import { MetricsService } from './metrics.service.js'

// Route EXCLUE de l'auto-mesure : le scrape de `/metrics` ne doit jamais
// s'observer lui-même — sinon chaque scrape ferait grossir l'histogramme
// qu'il vient de lire, biaisant la métrique par la fréquence de scrape
// plutôt que par le trafic applicatif réel (et compliquant le diagnostic :
// « la latence de /metrics inclut la latence de scrape précédente »).
const EXCLUDED_ROUTE = '/metrics'

// Interceptor HTTP global (Task 8, plan phase 5 it.2, spec §6) — observe
// `http_request_duration_seconds{method,route,status}` pour CHAQUE requête
// qui atteint un handler (les rejets de guard, en amont des interceptors
// dans le pipeline Nest, ne sont donc jamais comptés ici — hors périmètre de
// cette métrique applicative).
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  // @Inject() explicite (motif BillingGuard/ApiKeyGuard) : sans lui, SWC
  // émet pour ce paramètre de type classe un ternaire fantôme
  // `design:paramtypes` dont la branche « false » n'est atteignable qu'en
  // cas d'import circulaire cassé — structurellement impossible ici, donc
  // jamais couvrable par un test.
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>()
    if (req.path === EXCLUDED_ROUTE) return next.handle()

    const start = process.hrtime.bigint()

    const observe = (status: number): void => {
      // Route NORMALISÉE : `req.route.path` est le PATTERN Express déjà
      // résolu par le routeur (ex: `/invoices/:id`), jamais l'URL réelle
      // (`/invoices/3f2a...`) — un histogramme Prometheus matérialise une
      // série temporelle PAR combinaison de labels distincte : une route
      // paramétrée par l'URL brute exploserait en une série par identifiant
      // vu en prod (cardinalité non bornée), ce qui dégrade Prometheus
      // lui-même (mémoire, requêtes PromQL). Repli sur le nom du handler si
      // `req.route` est absent (résolution de route incomplète — ne devrait
      // pas arriver en pratique une fois un handler atteint, mais
      // défensif : jamais de label basé sur une donnée non bornée).
      const route = req.route?.path ?? context.getHandler().name
      const durationSeconds =
        Number(process.hrtime.bigint() - start) / 1_000_000_000
      this.metrics.httpDuration.observe(
        { method: req.method, route, status: String(status) },
        durationSeconds,
      )
    }

    return next.handle().pipe(
      tap(() => {
        const res = context.switchToHttp().getResponse<Response>()
        observe(res.statusCode)
      }),
      // Compte aussi les erreurs : une requête qui échoue (validation,
      // ressource inconnue, etc.) reste une observation HTTP à part entière
      // — l'omettre biaiserait l'histogramme vers les seuls succès. Statut
      // tiré de l'exception si elle en porte un (`HttpException`), 500
      // sinon (erreur non maîtrisée, motif `ProblemDetailsFilter`).
      catchError((err: unknown) => {
        const status = err instanceof HttpException ? err.getStatus() : 500
        observe(status)
        return throwError(() => err)
      }),
    )
  }
}
