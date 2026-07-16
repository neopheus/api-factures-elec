import { MODULE_METADATA } from '@nestjs/common/constants.js'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { ANNUAIRE_TRANSPORT } from '../../src/annuaire/annuaire.port.js'
import { AnnuaireTransportModule } from '../../src/annuaire/annuaire-transport.module.js'
import { LocalFilesystemAnnuaireStore } from '../../src/annuaire/local-filesystem-annuaire-store.js'

// `annuaire-transport.module.ts` est exclu de la couverture globale
// (`**/*.module.ts`, cf. vitest.config.ts) — pur câblage DI. On extrait
// néanmoins le factory du provider ANNUAIRE_TRANSPORT via les métadonnées
// Nest (mêmes clés que le décorateur @Module) pour PROUVER que les branches
// api/edi throw explicitement, sans avoir à instancier tout le module Nest
// ni écrire les adaptateurs réels (calque ereporting-transmission.module.test.ts,
// 2.3/Task 6).
function fakeConfig(
  values: Record<string, unknown>,
): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    never,
    true
  >
}

function getTransportFactory() {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    AnnuaireTransportModule,
  ) as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => unknown
  }>
  const provider = providers.find((p) => p.provide === ANNUAIRE_TRANSPORT)
  if (!provider)
    throw new Error(
      'ANNUAIRE_TRANSPORT provider not found on AnnuaireTransportModule',
    )
  return provider.useFactory
}

describe('AnnuaireTransportModule ANNUAIRE_TRANSPORT factory', () => {
  it("returns a LocalFilesystemAnnuaireStore for the 'local' driver", () => {
    const factory = getTransportFactory()
    const store = factory(
      fakeConfig({
        ANNUAIRE_DRIVER: 'local',
        ANNUAIRE_LOCAL_DIR: './var/annuaire',
      }),
    )
    expect(store).toBeInstanceOf(LocalFilesystemAnnuaireStore)
  })

  it.each(['api', 'edi'])(
    "throws explicitly for the '%s' driver (adapter activated at deploy time, not provided in 2.4)",
    (driver) => {
      const factory = getTransportFactory()
      expect(() => factory(fakeConfig({ ANNUAIRE_DRIVER: driver }))).toThrow(
        /activé au déploiement \(non fourni en 2\.4\)/,
      )
    },
  )
})
