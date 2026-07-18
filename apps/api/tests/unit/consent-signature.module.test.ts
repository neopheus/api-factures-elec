import { MODULE_METADATA } from '@nestjs/common/constants.js'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { ConsentSignatureModule } from '../../src/annuaire/consent-signature.module.js'
import { CONSENT_SIGNATURE } from '../../src/annuaire/consent-signature.port.js'
import { LocalFilesystemConsentStore } from '../../src/annuaire/local-filesystem-consent-store.js'

// `consent-signature.module.ts` est exclu de la couverture globale
// (`**/*.module.ts`, cf. vitest.config.ts) — pur câblage DI. On extrait
// néanmoins le factory du provider CONSENT_SIGNATURE via les métadonnées
// Nest (mêmes clés que le décorateur @Module) pour PROUVER que la branche
// eidas throw explicitement, sans avoir à instancier tout le module Nest ni
// écrire l'adaptateur réel (calque cdv-transmission.module.test.ts 3.1).
function fakeConfig(
  values: Record<string, unknown>,
): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    never,
    true
  >
}

function getSignatureFactory() {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    ConsentSignatureModule,
  ) as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => unknown
  }>
  const provider = providers.find((p) => p.provide === CONSENT_SIGNATURE)
  if (!provider)
    throw new Error(
      'CONSENT_SIGNATURE provider not found on ConsentSignatureModule',
    )
  return provider.useFactory
}

describe('ConsentSignatureModule CONSENT_SIGNATURE factory', () => {
  it("returns a LocalFilesystemConsentStore for the 'local' driver", () => {
    const factory = getSignatureFactory()
    const store = factory(
      fakeConfig({
        CONSENT_DRIVER: 'local',
        CONSENT_LOCAL_DIR: './var/consent',
      }),
    )
    expect(store).toBeInstanceOf(LocalFilesystemConsentStore)
  })

  it.each(['eidas'])(
    "throws explicitly for the '%s' driver (provider activated at deploy time, not provided in 3.5)",
    (driver) => {
      const factory = getSignatureFactory()
      expect(() => factory(fakeConfig({ CONSENT_DRIVER: driver }))).toThrow(
        /activé au déploiement \(non fourni en 3\.5\)/,
      )
    },
  )
})
