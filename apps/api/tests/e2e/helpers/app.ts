import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { AppModule } from '../../../src/app.module.js'
import { ProblemDetailsFilter } from '../../../src/common/http-exception.filter.js'
import { APP_POOL, createPool } from '../../../src/db/client.js'

// supertest, quand on lui passe un http.Server NON-écoutant, fait un
// listen(0)/close() éphémère À CHAQUE requête (`request(app.getHttpServer())`
// répété dans chaque `it`). Sous forte concurrence (~50 fichiers e2e en
// parallèle, chacun avec son propre serveur), ce churn de ports permet au
// noyau de réassigner un port fraîchement libéré à un AUTRE serveur avant
// qu'une connexion tardive n'arrive à destination — d'où des réponses
// croisées entre apps (401/404/503/erreurs de parsing HTTP observées de
// façon intermittente en investigation post-revue 1.4, cf.
// .superpowers/sdd). Démarrer l'écoute UNE SEULE FOIS ici, avant tout retour
// à l'appelant, fait que supertest voit `server.address()` déjà non-null et
// RÉUTILISE ce même écouteur pour toute la durée de vie du fichier — le port
// reste stable et n'est libéré qu'au `close()` du teardown existant (jamais
// de bind/unbind en cours de test).
export function listenOnce(app: INestApplication): Promise<void> {
  const server = app.getHttpServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

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
  await listenOnce(app)
  return app
}
