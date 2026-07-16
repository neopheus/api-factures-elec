import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Verrou d'architecture (revue T7 plan 3.3, NIT-1 — même esprit que le verrou
// apiKeyId, T6) : `HEAVY_TESTS` (vitest.config.ts) est une allowlist codée en
// dur ; sans ce test, une FUTURE suite e2e démarrant des Workers BullMQ
// (`createTestWorker`) tomberait silencieusement dans le projet `light`
// PARALLÈLE — et réintroduirait la contention testcontainers que le split
// heavy/light élimine (re-flake latent, cf. D11 + rapport Task 7).
//
// RALENTISSEUR honnête, pas une garantie : il détecte l'usage direct de
// `createTestWorker(` dans tests/e2e ; un wrapper/alias y échapperait.
// Invariant testé : { fichiers e2e utilisant createTestWorker } == HEAVY_TESTS
// (égalité STRICTE : un fichier listé heavy qui n'a plus de worker doit être
// rétrogradé consciemment, pas rester sérialisé par inertie).
const API_ROOT = join(__dirname, '..', '..')
const E2E_DIR = join(API_ROOT, 'tests', 'e2e')
const VITEST_CONFIG = join(API_ROOT, 'vitest.config.ts')

function heavyTestsFromConfig(): string[] {
  const source = readFileSync(VITEST_CONFIG, 'utf8')
  const match = source.match(/const HEAVY_TESTS = \[([^\]]*)\]/)
  if (!match?.[1]) {
    throw new Error(
      'heavy-suites.arch: HEAVY_TESTS introuvable dans vitest.config.ts — le verrou doit être mis à jour avec la config',
    )
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string).sort()
}

function workerConsumersFromSources(): string[] {
  return readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.e2e.test.ts'))
    .filter((f) =>
      readFileSync(join(E2E_DIR, f), 'utf8').includes('createTestWorker('),
    )
    .map((f) => `tests/e2e/${f}`)
    .sort()
}

describe("verrou d'architecture — suites lourdes (HEAVY_TESTS ≡ consommateurs de createTestWorker)", () => {
  it('toute suite e2e démarrant des Workers BullMQ est listée dans HEAVY_TESTS, et réciproquement', () => {
    expect(heavyTestsFromConfig()).toEqual(workerConsumersFromSources())
  })
})
