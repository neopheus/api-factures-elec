import { timingSafeEqual } from 'node:crypto'
import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SkipThrottle } from '@nestjs/throttler'
import type { Request, Response } from 'express'
import { ProblemType, problem } from '../common/problem.js'
import type { EnvConfig } from '../config/env.js'
import { MetricsService } from './metrics.service.js'

// GET /metrics — scrape Prometheus (Task 8, plan phase 5 it.2, spec §6).
// AUCUN guard de session/clé API ici : un scraper Prometheus n'a ni cookie
// ni clé applicative — la protection est un unique Bearer token dédié
// (`METRICS_TOKEN`, env optionnelle), lu UNE FOIS au constructeur (motif
// `BillingGuard` : config figée au démarrage du process, jamais réévaluée
// par requête — un changement de token exige un redéploiement).
// `@SkipThrottle()` : un scrape périodique (souvent <60s) ne doit jamais se
// faire jeter par le rate limiting global par IP (`ThrottlerGuard`,
// `APP_GUARD`), motif `HealthController`/`BillingWebhookController`.
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  private readonly token: string | undefined

  // @Inject() explicite sur les deux dépendances (motif `BillingGuard`) :
  // élimine le ternaire fantôme `design:paramtypes` émis par SWC pour tout
  // paramètre de type classe, sans quoi 2 branches resteraient
  // structurellement inatteignables en coverage v8.
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(ConfigService) config: ConfigService<EnvConfig, true>,
  ) {
    this.token = config.get('METRICS_TOKEN', { infer: true })
  }

  @Get()
  async scrape(
    @Req() req: Request,
    // `@Res()` (pas `passthrough`) : on contrôle nous-mêmes l'en-tête
    // Content-Type (format Prometheus text, pas JSON) et le corps — motif
    // `InvoicesController.getFormat` (octets bruts / type non-JSON). Les
    // exceptions ci-dessous sont levées AVANT tout accès à `res` : elles
    // restent captées normalement par `ProblemDetailsFilter`.
    @Res() res: Response,
    @Headers('authorization') authorization: string | undefined,
  ): Promise<void> {
    // Token absent de l'env → route opt-in désactivée : 404 INDISCERNABLE
    // d'une route qui n'existe pas. Ne JAMAIS laisser deviner à un tiers non
    // authentifié que `/metrics` EXISTE mais est simplement mal protégée
    // (spec §9 : « /metrics sans token configuré → 404 »). Le corps
    // reproduit EXACTEMENT celui que Nest produit pour une route non
    // matchée — `Cannot ${method} ${originalUrl}` (vérifié empiriquement
    // contre le comportement par défaut, cf. rapport de tâche) — plutôt
    // qu'un message fixe qui serait distinguable par comparaison littérale.
    if (!this.token) {
      throw new NotFoundException(
        problem(404, ProblemType.notFound, 'Not Found', {
          detail: `Cannot ${req.method} ${req.originalUrl}`,
        }),
      )
    }
    // Comparaison à TEMPS CONSTANT (motif `safeEqualHex`/
    // `FakeBillingDriver.constructWebhookEvent`, revue Task 8) : un `!==`
    // sur des chaînes s'arrête au premier octet différent — la latence
    // observable varie donc avec le nombre de caractères corrects, ce qui
    // permet de reconstituer le token par mesure de temps répétée. Surface
    // aggravée ICI par `@SkipThrottle()` : rien ne borne le nombre
    // d'essais qu'un attaquant peut envoyer à `/metrics`. `timingSafeEqual`
    // exige des buffers de MÊME LONGUEUR (throw sinon) — la garde de
    // longueur ci-dessous court-circuite en 401 AVANT tout appel, avec la
    // MÊME issue que « longueur égale mais contenu différent » (`||`, pas
    // de branche distincte) ; `authorization` absent devient une chaîne
    // vide, dont la longueur ne peut jamais matcher `Bearer ${token}`,
    // donc 401 générique lui aussi, jamais d'oracle sur sa présence.
    const expected = Buffer.from(`Bearer ${this.token}`, 'utf8')
    const presented = Buffer.from(authorization ?? '', 'utf8')
    if (
      expected.length !== presented.length ||
      !timingSafeEqual(expected, presented)
    ) {
      throw new UnauthorizedException(
        problem(401, ProblemType.unauthorized, 'Unauthorized'),
      )
    }
    const body = await this.metrics.render()
    res.setHeader('Content-Type', this.metrics.contentType)
    res.send(body)
  }
}
