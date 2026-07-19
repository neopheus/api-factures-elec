// Effet de bord volontaire, à importer EN PREMIER (avant `./app.js`, donc
// avant AppModule) par `billing-endpoints.e2e.test.ts` : même contrainte déjà
// documentée par `rate-limit-env.ts` — ConfigModule.forRoot() valide
// process.env de façon SYNCHRONE, avant tout `await`, dès le chargement
// transitif d'AppModule (donc AVANT qu'un `beforeAll` s'exécute). BILLING_DRIVER
// vaut 'none' par défaut (env.ts) : ce fichier de test a besoin du driver
// 'fake' (checkout/portal en mémoire, sans compte Stripe réel) pour exercer
// les 2 endpoints POST sans jamais lever `BillingDisabledError`.
process.env.BILLING_DRIVER = 'fake'
