import { MODULE_METADATA } from '@nestjs/common/constants.js'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { EreportingTransmissionModule } from '../../src/ereporting/ereporting-transmission.module.js'
import { FLUX10_TRANSMISSION } from '../../src/ereporting/flux10-transmission.port.js'
import { LocalFilesystemTransmissionStore } from '../../src/ereporting/local-filesystem-transmission-store.js'

// `ereporting-transmission.module.ts` est exclu de la couverture globale
// (`**/*.module.ts`, cf. vitest.config.ts) — pur câblage DI. On extrait
// néanmoins le factory du provider FLUX10_TRANSMISSION via les métadonnées
// Nest (mêmes clés que le décorateur @Module) pour PROUVER que les branches
// sftp/as2/as4/api throw explicitement, sans avoir à instancier tout le
// module Nest ni écrire les adaptateurs réels (cf. plan Task 6 Step 2, calque
// archive.module.test.ts 2.2/T5).
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
    EreportingTransmissionModule,
  ) as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => unknown
  }>
  const provider = providers.find((p) => p.provide === FLUX10_TRANSMISSION)
  if (!provider)
    throw new Error(
      'FLUX10_TRANSMISSION provider not found on EreportingTransmissionModule',
    )
  return provider.useFactory
}

describe('EreportingTransmissionModule FLUX10_TRANSMISSION factory', () => {
  it("returns a LocalFilesystemTransmissionStore for the 'local' driver", () => {
    const factory = getTransmissionFactory()
    const store = factory(
      fakeConfig({
        EREPORTING_TRANSMISSION_DRIVER: 'local',
        EREPORTING_LOCAL_DIR: './var/ereporting',
      }),
    )
    expect(store).toBeInstanceOf(LocalFilesystemTransmissionStore)
  })

  it.each(['sftp', 'as2', 'as4', 'api'])(
    "throws explicitly for the '%s' driver (adapter activated at deploy time, not provided in 2.3)",
    (driver) => {
      const factory = getTransmissionFactory()
      expect(() =>
        factory(fakeConfig({ EREPORTING_TRANSMISSION_DRIVER: driver })),
      ).toThrow(/activé au déploiement \(non fourni en 2\.3\)/)
    },
  )
})
