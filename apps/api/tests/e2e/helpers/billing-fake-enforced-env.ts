// Effet de bord volontaire, à importer EN PREMIER (avant `./app.js`, donc
// avant AppModule) par `billing-guard.e2e.test.ts` — même contrainte que
// `billing-fake-env.ts` : `ConfigModule.forRoot()` valide `process.env` de
// façon SYNCHRONE, avant tout `await`, dès le chargement transitif
// d'AppModule (donc AVANT qu'un `beforeAll` s'exécute).
//
// Distinct de `billing-fake-env.ts` (qui pose seulement BILLING_DRIVER=fake,
// enforcement 'off' par défaut) : ce fichier pose EN PLUS
// BILLING_ENFORCEMENT=on, requis pour exercer le 402 réel de `BillingGuard`
// — les autres suites e2e billing (checkout/portal/status, webhook) tournent
// délibérément enforcement 'off' implicite (elles ne testent pas le garde),
// d'où un fichier séparé plutôt qu'un changement partagé.
process.env.BILLING_DRIVER = 'fake'
process.env.BILLING_ENFORCEMENT = 'on'
