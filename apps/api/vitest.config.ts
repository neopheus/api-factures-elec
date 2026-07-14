import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    // ≥ 150 s : le beforeAll de chaque fichier e2e démarre un conteneur
    // Postgres (délai de démarrage porté à 120 s dans helpers/postgres.ts
    // pour absorber la charge Docker sous forte concurrence) PUIS applique
    // les rôles/migrations — le hook doit pouvoir dépasser les 120 s du seul
    // démarrage du conteneur.
    hookTimeout: 150_000,
    // Plafond de concurrence des e2e (Testcontainers) : chaque fichier e2e
    // démarre son propre conteneur Postgres réel ET son propre serveur HTTP
    // éphémère (supertest). Un parallélisme non borné (défaut : ~nombre de
    // cœurs, ex. 12 en local) fait tourner des dizaines de conteneurs +
    // serveurs HTTP simultanément, saturant les ressources partagées
    // (CPU/sockets/Docker Desktop — VM Docker souvent limitée à quelques
    // vCPU). Investigation post-revue 1.4 (.superpowers/sdd) : sous forte
    // charge, quelques échecs sporadiques et non reproductibles isolément
    // (statut HTTP inattendu sur des routes autrement stables — hypothèse de
    // scission de seau par dualité d'adresse localhost infirmée par
    // diagnostic direct ; mécanisme exact non totalement élucidé, cohérent
    // avec une contention de ressources plutôt qu'un bug applicatif). 5
    // aligné sur la réalité des runners CI (2-4 cœurs) : réduit la
    // contention en local ET en CI, sans dégrader le temps total de façon
    // sensible (les fichiers restants continuent en pipeline dès qu'un slot
    // se libère).
    maxWorkers: 5,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclus : bootstrap et pur câblage DI (aucune logique à couvrir).
      exclude: ['src/main.ts', '**/*.module.ts', 'src/db/migrations/**'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
