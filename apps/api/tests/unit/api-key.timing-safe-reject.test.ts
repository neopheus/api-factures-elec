import { afterEach, describe, expect, it, vi } from 'vitest'

// Fichier séparé de tests/unit/api-key.test.ts (qui reste identique au brief,
// Step 1) : verrouille le comportement défensif de timingSafeReject() —
// n'appelle JAMAIS le module en dehors de ce test avec un mock, pour ne pas
// perturber le cache `dummyHash` (module-scope, persistant) exercé par les
// autres tests/e2e de la suite.
describe('timingSafeReject (defensive isolation)', () => {
  afterEach(() => {
    vi.doUnmock('@node-rs/argon2')
    vi.resetModules()
  })

  it('never rejects even if the underlying argon2 verify call throws (native binding failure)', async () => {
    vi.resetModules()
    vi.doMock('@node-rs/argon2', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@node-rs/argon2')>()
      return {
        ...actual,
        verify: vi.fn().mockRejectedValue(new Error('native binding exploded')),
      }
    })

    const { timingSafeReject } = await import('../../src/auth/api-key.js')

    // Doit résoudre (jamais rejeter) : une erreur ici romprait l'ApiKeyGuard
    // sur le chemin "préfixe inconnu/révoqué" (500 au lieu du 401 attendu).
    await expect(timingSafeReject('any-secret')).resolves.toBeUndefined()
  })
})
