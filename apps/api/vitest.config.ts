import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclus : bootstrap et pur câblage DI (aucune logique à couvrir).
      exclude: ['src/main.ts', '**/*.module.ts', 'src/db/migrations/**'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
