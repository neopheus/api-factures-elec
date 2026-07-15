import { describe, expect, it, vi } from 'vitest'
import { SessionMaintenanceService } from '../../src/worker/session-maintenance.service.js'

describe('SessionMaintenanceService.purgeExpiredSessions', () => {
  it('calls the SECURITY DEFINER function and returns the deleted count', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ n: 4 }] }) }
    const service = new SessionMaintenanceService(pool as never)

    const n = await service.purgeExpiredSessions()

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT purge_expired_sessions() AS n',
    )
    expect(n).toBe(4)
  })

  it('defaults to 0 when the query returns no row', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const service = new SessionMaintenanceService(pool as never)

    const n = await service.purgeExpiredSessions()

    expect(n).toBe(0)
  })
})
