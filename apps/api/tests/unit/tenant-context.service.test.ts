import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { TenantContextService } from '../../src/db/tenant-context.service.js'

describe('TenantContextService', () => {
  it('delegates run() to runInTenant using the pool injected in the constructor', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const release = vi.fn()
    const client = { query, release }
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool

    const service = new TenantContextService(pool)
    const result = await service.run('tenant-xyz', async () => 'value')

    expect(result).toBe('value')
    expect(query.mock.calls[0]).toEqual(['BEGIN'])
    expect(query.mock.calls[1]).toEqual([
      "SELECT set_config('app.tenant_id', $1, true)",
      ['tenant-xyz'],
    ])
    expect(query.mock.calls[2]).toEqual(['COMMIT'])
    expect(release).toHaveBeenCalledTimes(1)
  })
})
