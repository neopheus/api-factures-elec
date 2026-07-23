import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { AppModule } from '../../../src/app.module.js'
import { ProblemDetailsFilter } from '../../../src/common/http-exception.filter.js'
import { APP_POOL, createPool } from '../../../src/db/client.js'
import { setupPublicOpenApi } from '../../../src/openapi/openapi.setup.js'
import { REDIS_CONNECTION } from '../../../src/queue/redis-connection.module.js'

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
//
// `redis` (optionnel) : override du provider REDIS_CONNECTION (token GLOBAL,
// cf. queue/redis-connection.module.ts) avec les coordonnées d'un Redis de
// test (Testcontainers, port dynamique) — même raison que ci-dessus pour
// APP_POOL : ConfigService ne peut pas connaître ce port à l'avance. Vérifié
// empiriquement : l'override par token se propage bien dans la factory de
// `BullModule.forRootAsync` (injection par token, container Nest unifié) —
// le repli statique `QueueModule.forRoot(connection)` évoqué au plan n'est
// pas nécessaire. Sans ce paramètre, l'app pointe sur le Redis par défaut de
// l'environnement (localhost:6379) — les tests qui n'exercent jamais Redis
// (pas d'enfilement, pas de ping readiness) n'en pâtissent pas grâce à
// `lazyConnect` + `skipWaitingForReady`/`skipVersionCheck` (cf.
// queue.module.ts) : aucune connexion réelle n'est ouverte tant que rien ne
// l'exige.
export async function createTestApp(
  appUrl: string,
  redis?: { host: string; port: number },
  opts?: { rawBody?: boolean },
): Promise<INestApplication> {
  process.env.DATABASE_URL = appUrl
  process.env.LOG_LEVEL = 'silent'
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_POOL)
    .useFactory({ factory: () => createPool(appUrl) })
  if (redis) {
    builder.overrideProvider(REDIS_CONNECTION).useValue({
      host: redis.host,
      port: redis.port,
      lazyConnect: true,
    })
  }
  const moduleRef = await builder.compile()
  // `rawBody` : opt-in (défaut `false`, comportement inchangé pour tous les
  // autres fichiers e2e) — seule la suite billing webhook (Task 7) en a
  // besoin, motif `main.ts` (vérification de signature Stripe sur le corps
  // brut).
  const app = moduleRef.createNestApplication({
    bufferLogs: true,
    rawBody: opts?.rawBody ?? false,
  })
  app.use(helmet())
  app.use(cookieParser())
  app.useGlobalFilters(new ProblemDetailsFilter())
  app.enableShutdownHooks()
  // Motif main.ts : le harnais e2e monte l'app complète manuellement (pas
  // bootstrap()) — la doc OpenAPI publique doit donc être posée ICI aussi
  // pour que `GET /openapi.json` soit exerçable en e2e (openapi.e2e.test.ts).
  setupPublicOpenApi(app)
  await app.init()
  await listenOnce(app)
  return app
}
