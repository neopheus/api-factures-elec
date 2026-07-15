import { MODULE_METADATA } from '@nestjs/common/constants.js'
import type { ConfigService } from '@nestjs/config'
import { describe, expect, it } from 'vitest'
import { ArchiveModule } from '../../src/archive/archive.module.js'
import { ARCHIVE_STORE } from '../../src/archive/archive-store.port.js'
import { LocalFilesystemArchiveStore } from '../../src/archive/local-filesystem-archive-store.js'

// `archive.module.ts` est exclu de la couverture globale (`**/*.module.ts`,
// cf. vitest.config.ts) — pur câblage DI. On extrait néanmoins le factory du
// provider ARCHIVE_STORE via les métadonnées Nest (mêmes clés que le
// décorateur @Module) pour PROUVER que la branche `s3` throw explicitement,
// sans avoir à instancier tout le module Nest ni écrire d'adaptateur S3
// (cf. plan Task 5 Step 3).
function fakeConfig(
  values: Record<string, unknown>,
): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    never,
    true
  >
}

function getArchiveStoreFactory() {
  const providers = Reflect.getMetadata(
    MODULE_METADATA.PROVIDERS,
    ArchiveModule,
  ) as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => unknown
  }>
  const provider = providers.find((p) => p.provide === ARCHIVE_STORE)
  if (!provider)
    throw new Error('ARCHIVE_STORE provider not found on ArchiveModule')
  return provider.useFactory
}

describe('ArchiveModule ARCHIVE_STORE factory', () => {
  it("returns a LocalFilesystemArchiveStore for the 'local' driver", () => {
    const factory = getArchiveStoreFactory()
    const store = factory(
      fakeConfig({
        ARCHIVE_DRIVER: 'local',
        ARCHIVE_LOCAL_DIR: './var/archive',
      }),
    )
    expect(store).toBeInstanceOf(LocalFilesystemArchiveStore)
  })

  it("throws explicitly for the 's3' driver (adapter deployed at ops time, not provided in 2.2)", () => {
    const factory = getArchiveStoreFactory()
    expect(() => factory(fakeConfig({ ARCHIVE_DRIVER: 's3' }))).toThrow(
      /ARCHIVE_DRIVER='s3'/,
    )
  })
})
