import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { AppModule } from '../../../src/app.module.js'
import { ProblemDetailsFilter } from '../../../src/common/http-exception.filter.js'
import { APP_POOL, createPool } from '../../../src/db/client.js'

// Monte l'app complète en pointant le pool applicatif sur l'URL factelec_app du
// conteneur de test (override du provider APP_POOL, cf. ci-dessous). Ces deux
// assignations documentent l'intention mais n'influencent PAS la validation
// zod de ConfigModule : ConfigModule.forRoot() est appelée de façon eager, au
// chargement du module (donc avant l'exécution de cette fonction) — les
// valeurs par défaut réellement utilisées sont posées dans tests/setup.ts.
export async function createTestApp(appUrl: string): Promise<INestApplication> {
  process.env.DATABASE_URL = appUrl
  process.env.LOG_LEVEL = 'silent'
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
    .compile()
  const app = moduleRef.createNestApplication({ bufferLogs: true })
  app.use(helmet())
  app.use(cookieParser())
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks()
  await app.init()
  return app
}
