import { defineConfig } from 'vitest/config'

export default defineConfig({
  // transform TSX sans @vitejs/plugin-react. Vite 8 (Vitest 4.1.10) transforme par défaut
  // via `oxc`, pas `esbuild` (le champ `esbuild` est ignoré — dépréciation confirmée par un
  // avertissement au run). Équivalent oxc de la config esbuild prescrite par le brief.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
      // Exclusions bornées (mandat contrôleur task 8) : coques Next (src/app/**) et types
      // purs (api-types.ts) uniquement. client.ts EST couvert (tests/lib/client.test.ts).
      exclude: ['src/app/**', '**/*.d.ts', 'src/lib/api-types.ts'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 90 },
    },
  },
})
