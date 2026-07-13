import 'reflect-metadata'

// ConfigModule.forRoot() valide process.env de façon EAGER, au chargement du
// module — avant qu'un test ait pu poser sa propre valeur (ex: createTestApp
// pointant sur le conteneur Testcontainers). Un placeholder syntaxiquement
// valide suffit ici : les e2e qui montent l'app complète overrident ensuite le
// provider APP_POOL avec le pool réel — cette valeur ne sert jamais à une
// connexion effective.
process.env.DATABASE_URL ??=
  'postgres://placeholder:placeholder@localhost:5432/placeholder'
// Idem pour LOG_LEVEL : évite de polluer stdout avec les logs HTTP pino des
// e2e qui montent l'app complète (health.e2e.test.ts).
process.env.LOG_LEVEL ??= 'silent'
