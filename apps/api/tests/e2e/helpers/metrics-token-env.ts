// Effet de bord volontaire, à importer EN PREMIER (avant `./app.js`, donc
// avant AppModule) par `metrics.e2e.test.ts` : même contrainte déjà
// documentée par `rate-limit-env.ts`/`billing-fake-env.ts` — ConfigModule.
// forRoot() valide process.env de façon SYNCHRONE, avant tout `await`, dès
// le chargement transitif d'AppModule (donc AVANT qu'un `beforeAll` ne
// s'exécute). METRICS_TOKEN est absente par défaut (env.ts, opt-in) : ce
// fichier pose un token de test (≥16 caractères, contrainte zod) pour
// exercer le scrape protégé (401 mauvais token / 200 bon token) dans les
// describe « token présent » de metrics.e2e.test.ts. Le scénario « token
// absent → 404 » vit dans un describe SÉPARÉ du même fichier, monté via un
// module Nest minimal (motif security-headers.e2e.test.ts) avec une
// `ConfigService` surchargée manuellement — il ne charge jamais AppModule et
// n'entre donc jamais en conflit avec cette valeur figée au niveau fichier.
process.env.METRICS_TOKEN = 'e2e-metrics-token-1234567890'
