import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
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
