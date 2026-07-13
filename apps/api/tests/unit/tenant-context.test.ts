import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { runInTenant } from '../../src/db/tenant-context.js'

function fakeClient(
  queryImpl?: (...args: unknown[]) => Promise<{ rows: unknown[] }>,
) {
  const query = vi.fn(queryImpl ?? (async () => ({ rows: [] })))
  const release = vi.fn()
  return { query, release }
}

function fakePool(client: {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}) {
  const connect = vi.fn().mockResolvedValue(client)
  return { connect } as unknown as pg.Pool
}

describe('runInTenant (unit — séquence de commandes, sans Postgres réel)', () => {
  it('checks out exactly one client, opens BEGIN, sets app.tenant_id via SET LOCAL, then COMMITs and releases', async () => {
    const client = fakeClient()
    const pool = fakePool(client)

    const result = await runInTenant(pool, 'tenant-123', async () => 'ok')

    expect(pool.connect as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
    expect(client.query.mock.calls[0]).toEqual(['BEGIN'])
    expect(client.query.mock.calls[1]).toEqual([
      "SELECT set_config('app.tenant_id', $1, true)",
      ['tenant-123'],
    ])
    expect(client.query.mock.calls[2]).toEqual(['COMMIT'])
    expect(client.query).toHaveBeenCalledTimes(3)
    expect(client.release).toHaveBeenCalledTimes(1)
    expect(result).toBe('ok')
  })

  it('hands work a db bound to the SAME client acquired from the pool', async () => {
    const client = fakeClient()
    const pool = fakePool(client)

    let received: unknown
    await runInTenant(pool, 'tenant-123', async (d) => {
      received = d
    })

    expect(received).toBeDefined()
  })

  it('rolls back and releases (never commits) when work throws, and rethrows the original error', async () => {
    const client = fakeClient()
    const pool = fakePool(client)

    await expect(
      runInTenant(pool, 'tenant-123', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(client.query.mock.calls.map((c) => c[0])).toEqual([
      'BEGIN',
      "SELECT set_config('app.tenant_id', $1, true)",
      'ROLLBACK',
    ])
    expect(client.query.mock.calls.some((c) => c[0] === 'COMMIT')).toBe(false)
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('still releases the client when COMMIT itself rejects', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // set_config
      .mockRejectedValueOnce(new Error('commit failed')) // COMMIT
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK (catch)
    const release = vi.fn()
    const client = { query, release }
    const pool = fakePool(client)

    await expect(
      runInTenant(pool, 'tenant-123', async () => 'value'),
    ).rejects.toThrow('commit failed')
    expect(release).toHaveBeenCalledTimes(1)
  })
})
