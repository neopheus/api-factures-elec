import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import { ProblemDetailsFilter } from './common/http-exception.filter.js'
import type { EnvConfig } from './config/env.js'
import { setupPublicOpenApi } from './openapi/openapi.setup.js'

async function bootstrap(): Promise<void> {
  // `rawBody: true` : nécessaire au webhook Stripe (BillingWebhookController,
  // Task 7) qui doit vérifier la signature HMAC sur le corps BRUT de la
  // requête — le body-parser JSON de Nest reconstruit un JSON.stringify qui
  // ne correspond PAS bit-à-bit au payload envoyé par Stripe (ordre des
  // clés, espaces) et ferait échouer toute vérification de signature. Nest
  // expose alors `req.rawBody` (type `RawBodyRequest<Request>`) SANS changer
  // le comportement du parsing JSON pour tous les autres endpoints.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  })
  app.useLogger(app.get(Logger))
  const config = app.get<ConfigService<EnvConfig, true>>(ConfigService)

  app.use(helmet())
  app.use(cookieParser())
  app.enableCors({
    origin: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token'],
    credentials: true, // cookies de session cross-subdomain (dashboard ↔ API)
  })

  // `trust proxy` : désactivé (0) par défaut — comportement actuel inchangé.
  // À positionner au nombre de proxys de confiance devant l'API (LB /
  // reverse-proxy) pour que le rate limiting par IP (`ThrottlerGuard`) lise
  // la vraie IP client via `X-Forwarded-For` plutôt que l'IP du proxy (qui
  // ferait retomber TOUS les clients dans le même seau de throttling).
  // JAMAIS `true` : cf. commentaire TRUST_PROXY dans config/env.ts.
  const trustProxy = config.get('TRUST_PROXY', { infer: true })
  if (trustProxy > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', trustProxy)
  }
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks() // SIGTERM/SIGINT → onModuleDestroy (fermeture du pool DB, Task 5)
  // Doc OpenAPI 3.1 du périmètre PUBLIC clé-API (phase 4 it.1, spec §2) :
  // JSON seul, sans UI, `GET /openapi.json` — cf. openapi/openapi.setup.ts
  // pour la liste explicite des modules inclus et la justification des
  // exclusions.
  setupPublicOpenApi(app)

  await app.listen(config.get('PORT', { infer: true }))
}

void bootstrap()
