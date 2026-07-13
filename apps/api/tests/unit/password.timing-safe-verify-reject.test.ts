import { describe, expect, it } from 'vitest'
import { timingSafeVerifyReject } from '../../src/auth/password.js'

// Fichier séparé de tests/unit/password.test.ts (qui reste identique au
// brief, Step 1) : le brief ne teste pas timingSafeVerifyReject alors qu'elle
// sera le chemin emprunté par /auth/login quand l'email n'existe pas
// (anti-énumération). On verrouille ici : (a) qu'elle ne rejette jamais,
// (b) les deux branches de l'initialisation paresseuse `dummyHash ??= ...`
// (premier appel = calcul du hash leurre, appels suivants = réutilisation).
describe('timingSafeVerifyReject (dummy-hash equalizer)', () => {
  it('never rejects and reuses the lazily-computed dummy hash across calls', async () => {
    await expect(
      timingSafeVerifyReject('whatever-guess'),
    ).resolves.toBeUndefined()
    // Second appel : dummyHash déjà posé (branche droite de ??= non ré-exécutée).
    await expect(
      timingSafeVerifyReject('another-guess'),
    ).resolves.toBeUndefined()
  })
})
