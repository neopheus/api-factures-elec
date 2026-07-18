import type { ConfigService } from '@nestjs/config'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { APP_POOL } from '../../src/db/client.js'
import { DbModule } from '../../src/db/db.module.js'

describe('DbModule.onModuleDestroy', () => {
  it('est idempotent : pool.end() est invoqué une seule fois même si onModuleDestroy est appelé deux fois', async () => {
    const end = vi.fn().mockResolvedValue(undefined)
    const pool = { end } as unknown as pg.Pool
    const dbModule = new DbModule(pool)

    await dbModule.onModuleDestroy()
    await dbModule.onModuleDestroy()

    expect(end).toHaveBeenCalledTimes(1)
  })
})

// Split pool/rôle par bootstrap disjoint (D5, Task 3, plan 3.5) : `forRoot`
// est une méthode statique simple (pas de décorateur @Module sur son
// résultat) — on inspecte directement le `DynamicModule` retourné pour en
// extraire le factory du provider APP_POOL, motif metadata-extraction de
// consent-signature.module.test.ts (3.5) sans instancier tout l'arbre Nest.
function fakeConfig(
  values: Record<string, unknown>,
): ConfigService<never, true> {
  return { get: (key: string) => values[key] } as unknown as ConfigService<
    never,
    true
  >
}

function getPoolFactory(urlEnvKey: 'DATABASE_URL' | 'DATABASE_URL_WORKER') {
  const dynamic = DbModule.forRoot(urlEnvKey)
  const providers = dynamic.providers as Array<{
    provide: unknown
    useFactory: (config: ConfigService<never, true>) => pg.Pool
  }>
  const provider = providers.find((p) => p.provide === APP_POOL)
  if (!provider) {
    throw new Error('APP_POOL provider not found on DbModule.forRoot()')
  }
  return provider.useFactory
}

describe('DbModule.forRoot APP_POOL factory', () => {
  it('construit le pool depuis la clé env fournie quand elle est présente', async () => {
    const factory = getPoolFactory('DATABASE_URL')
    const pool = factory(
      fakeConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' }),
    )
    expect(pool).toBeDefined()
    await pool.end()
  })

  it('throw explicitement quand DATABASE_URL_WORKER est absente (garde bootstrap worker, D5)', () => {
    const factory = getPoolFactory('DATABASE_URL_WORKER')
    expect(() => factory(fakeConfig({}))).toThrow(
      /DATABASE_URL_WORKER requis pour le process worker/,
    )
  })
})
