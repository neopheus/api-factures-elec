// Effet de bord volontaire, à importer EN PREMIER (avant `./app.js`, donc
// avant AppModule) par `rate-limit.e2e.test.ts` : ConfigModule.forRoot() est
// une méthode `async` mais valide process.env de façon SYNCHRONE, avant tout
// `await`, dès l'appel — c'est-à-dire dès que `config.module.ts` est chargé
// (chargement transitif via AppModule), PAS au moment où un `beforeAll`
// s'exécute (qui a lieu après la résolution des imports du fichier). Même
// contrainte déjà documentée dans helpers/app.ts pour DATABASE_URL/LOG_LEVEL.
// Les imports ES sont hoistés et évalués dans leur ordre de déclaration avant
// tout code du fichier appelant : ce module doit donc précéder l'import de
// `./app.js` dans rate-limit.e2e.test.ts pour que le ThrottlerModule lise la
// limite basse au bootstrap. Restauré (delete) dans l'afterAll du test.
process.env.RATE_LIMIT_LIMIT = '3'
process.env.RATE_LIMIT_TTL = '60'
