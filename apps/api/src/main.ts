import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module.js'
import { ProblemDetailsFilter } from './common/http-exception.filter.js'
import type { EnvConfig } from './config/env.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true })
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

  await app.listen(config.get('PORT', { infer: true }))
}

void bootstrap()
