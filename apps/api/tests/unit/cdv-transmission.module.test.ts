import { MODULE_METADATA } from '@nestjs/common/constants.js'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { CdvTransmissionModule } from '../../src/cdv/cdv-transmission.module.js'
import { CDV_TRANSMISSION } from '../../src/cdv/cdv-transmission.port.js'
import { LocalFilesystemCdvStore } from '../../src/cdv/local-filesystem-cdv-store.js'

// `cdv-transmission.module.ts` est exclu de la couverture globale
// (`**/*.module.ts`, cf. vitest.config.ts) — pur câblage DI. On extrait
// néanmoins le factory du provider CDV_TRANSMISSION via les métadonnées Nest
// (mêmes clés que le décorateur @Module) pour PROUVER que les branches
// sftp/as2/as4/as4-peppol/api throw explicitement, sans avoir à instancier
// tout le module Nest ni écrire les adaptateurs réels (calque
// ereporting-transmission.module.test.ts 2.3 / annuaire-transport.module.test.ts
// 2.4).
function fakeConfig(
  values: Record<string, unknown>,
): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    never,
    true
  >
}

function getTransmissionFactory() {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    CdvTransmissionModule,
  ) as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => unknown
  }>
  const provider = providers.find((p) => p.provide === CDV_TRANSMISSION)
  if (!provider)
    throw new Error(
      'CDV_TRANSMISSION provider not found on CdvTransmissionModule',
    )
  return provider.useFactory
}

describe('CdvTransmissionModule CDV_TRANSMISSION factory', () => {
  it("returns a LocalFilesystemCdvStore for the 'local' driver", () => {
    const factory = getTransmissionFactory()
    const store = factory(
      fakeConfig({
        CDV_TRANSMISSION_DRIVER: 'local',
        CDV_LOCAL_DIR: './var/cdv',
      }),
    )
    expect(store).toBeInstanceOf(LocalFilesystemCdvStore)
  })

  it.each(['sftp', 'as2', 'as4', 'as4-peppol', 'api'])(
    "throws explicitly for the '%s' driver (adapter activated at deploy time, not provided in 3.1)",
    (driver) => {
      const factory = getTransmissionFactory()
      expect(() =>
        factory(fakeConfig({ CDV_TRANSMISSION_DRIVER: driver })),
      ).toThrow(/activé au déploiement \(non fourni en 3\.1\)/)
    },
  )
})
