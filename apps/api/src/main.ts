import 'reflect-metadata'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
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
  app.enableCors({
    origin: config.get('CORS_ALLOWED_ORIGINS', { infer: true }),
    methods: ['GET', 'POST'],
    credentials: false,
  })
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks() // SIGTERM/SIGINT → onModuleDestroy (fermeture du pool DB, Task 5)

  await app.listen(config.get('PORT', { infer: true }))
}

void bootstrap()
