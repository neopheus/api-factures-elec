import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // src/main.ts = pur bootstrap/câblage (aucune branche logique propre à
      // couvrir) — même exclusion que apps/api/vitest.config.ts.
      exclude: ['src/main.ts'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
