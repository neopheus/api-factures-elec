import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'
import type { Request } from 'express'
import { ProblemType, problem } from '../common/problem.js'
// biome-ignore lint/style/useImportType: BillingWebhookService est résolu par Nest via design:paramtypes (pas de @Inject() explicite ici) ; un import type-only effacerait la référence runtime et casserait la DI.
import { BillingWebhookService } from './billing-webhook.service.js'

// Webhook Stripe (Task 7, plan phase 5) — classe séparée de BillingController
// : AUCUN guard (ni SessionGuard, ni RolesGuard, ni CsrfGuard) car
// l'authenticité de la requête est garantie par la signature HMAC
// (`stripe-signature`), jamais par un cookie de session — Stripe n'a pas de
// session applicative. `@SkipThrottle()` : le rate limiting global par IP
// (`ThrottlerGuard`, `APP_GUARD` posé par AuthModule) ferait retomber TOUS
// les événements Stripe (émis depuis le pool d'IP partagé de Stripe, pas
// depuis un client final identifiable) dans le même seau — même motif que
// `HealthController`.
//
// 400 SANS détail, que ce soit `raw`/`signature` absents ou une signature
// invalide (`reason === 'signature'`) : ne jamais indiquer à un tiers
// POURQUOI la requête a été rejetée (contrat webhook = surface publique non
// authentifiée avant vérification de signature). Tout le reste (customer
// inconnu, événement sans statut, événement en retard) renvoie 200 — c'est
// le contrat Stripe : un 4xx/5xx déclenche des retries indéfinis côté
// Stripe pour des événements qu'on a délibérément choisi d'ignorer.
@SkipThrottle()
@Controller('billing')
export class BillingWebhookController {
  constructor(private readonly webhookService: BillingWebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    const raw = req.rawBody
    if (!raw || !signature)
      throw new BadRequestException(
        problem(400, ProblemType.validation, 'Bad request'),
      )
    const result = await this.webhookService.handle(raw, signature)
    if (result.reason === 'signature')
      throw new BadRequestException(
        problem(400, ProblemType.validation, 'Bad request'),
      )
    return { received: true }
  }
}
