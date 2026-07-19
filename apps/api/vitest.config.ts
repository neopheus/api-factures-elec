import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// D11 (plan 3.3, Task 7) : les 8 suites qui démarrent Postgres + Redis + des
// Workers BullMQ (chacune = un jeu COMPLET de conteneurs testcontainers) +
// invoice-routing (Task 2, même profil lourd) sont la source dominante de la
// contention observée en 3.2/3.3 (timeouts de démarrage, bruit de teardown,
// ping Redis en timeout) quand plusieurs démarrent en même temps. Elles
// tombent dans le projet `heavy`, exécuté en SÉRIE (`fileParallelism: false`,
// au plus un jeu de conteneurs lourds à la fois). Tout le reste (Postgres
// seul ou léger) reste dans `light`, parallèle (`maxWorkers: 5`).
const HEAVY_TESTS = [
  'tests/e2e/ereporting-generation.e2e.test.ts',
  'tests/e2e/ereporting-payments.e2e.test.ts',
  'tests/e2e/ereporting-retransmission.e2e.test.ts',
  'tests/e2e/annuaire-sync.e2e.test.ts',
  'tests/e2e/cdv-transmission-sweep.e2e.test.ts',
  'tests/e2e/async-generation.e2e.test.ts',
  'tests/e2e/archive-generation.e2e.test.ts',
  'tests/e2e/ereporting-sweep.e2e.test.ts',
  'tests/e2e/session-purge.e2e.test.ts',
  'tests/e2e/invoice-routing.e2e.test.ts',
  'tests/e2e/routing-retry.e2e.test.ts',
  'tests/e2e/billing-usage.e2e.test.ts',
]

export default defineConfig({
  test: {
    // Amendement m6 (BINDING) : en `test.projects`, la config racine ne
    // cascade PAS vers les projets (`extends: false`, comportement par
    // défaut de Vitest 4) — `coverage` est la SEULE option de test partagée
    // ici, et c'est volontaire : Vitest exige `coverage`/`reporters` au
    // niveau racine (non supportés dans une config de projet). Les seuils
    // s'appliquent à l'AGRÉGAT heavy+light (vérifié en pratique, cf. rapport
    // Task 7).
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclus : bootstrap et pur câblage DI (aucune logique à couvrir).
      exclude: [
        'src/main.ts',
        'src/worker-main.ts',
        '**/*.module.ts',
        'src/db/migrations/**',
      ],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
    projects: [
      {
        // Redéclaré ici (amendement m6) : `plugins`/`setupFiles`/timeouts ne
        // cascadent PAS depuis la racine — sans ceci, `tests/setup.ts`
        // (DATABASE_URL/LOG_LEVEL/*_LOCAL_DIR posés AVANT le chargement
        // eager de ConfigModule) ne s'appliquerait plus silencieusement.
        plugins: [swc.vite()],
        test: {
          name: 'heavy',
          globals: true,
          include: HEAVY_TESTS,
          setupFiles: ['tests/setup.ts'],
          testTimeout: 60_000,
          // ≥ 150 s : le beforeAll de chaque fichier e2e démarre un
          // conteneur Postgres (délai de démarrage porté à 120 s dans
          // helpers/postgres.ts) PUIS applique rôles/migrations, et ici en
          // plus Redis + les Workers BullMQ — le hook doit pouvoir dépasser
          // les 120 s du seul démarrage du conteneur Postgres.
          hookTimeout: 150_000,
          // Au plus un fichier heavy à la fois : élimine la contention
          // testcontainers dominante entre suites lourdes simultanées.
          fileParallelism: false,
        },
      },
      {
        // Redéclaré ici (amendement m6) : voir commentaire du projet `heavy`.
        plugins: [swc.vite()],
        test: {
          name: 'light',
          globals: true,
          include: ['tests/**/*.test.ts'],
          exclude: HEAVY_TESTS,
          setupFiles: ['tests/setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 150_000,
          // Plafond de concurrence des e2e/unit légers (Testcontainers) :
          // chaque fichier e2e démarre son propre conteneur Postgres réel ET
          // son propre serveur HTTP éphémère (supertest). Un parallélisme non
          // borné (défaut : ~nombre de cœurs, ex. 12 en local) fait tourner
          // des dizaines de conteneurs + serveurs HTTP simultanément,
          // saturant les ressources partagées (CPU/sockets/Docker Desktop —
          // VM Docker souvent limitée à quelques vCPU).
          //
          // Fallback BINDING (amendement m7, plan 3.3 Task 7) : 5 (aligné
          // CI 2-4 cœurs) a re-flaké en pratique — `invoices-repository.e2e`
          // (un des 4 fichiers surveillés nommément) + 2 autres suites
          // `light` ont échoué simultanément sur « Timed out … while
          // waiting for container ports to be bound to the host » (bind de
          // port testcontainers), le VM Docker local mesurant exactement 5
          // vCPU (`docker info`) — 5 conteneurs Postgres démarrés en même
          // temps saturent la totalité du budget CPU du démon. Abaissé à 3
          // (headroom sous le plafond Docker) plutôt que de conclure
          // « vert » sur un run simplement plus chanceux — voir rapport
          // Task 7 pour les batteries de re-vérification post-fallback.
          //
          // Surcharge CI (2026-07-19) : les runners GitHub ubuntu-latest
          // (2 vCPU) saturent même à 3 conteneurs Postgres simultanés
          // (hook timeouts 150 s en série constatés depuis le plan 2.3) —
          // le job e2e de ci.yml pose VITEST_LIGHT_MAX_WORKERS=2. Le défaut
          // local reste 3 (fallback binding m7 inchangé).
          maxWorkers: Number(process.env.VITEST_LIGHT_MAX_WORKERS ?? '3'),
        },
      },
    ],
  },
})
