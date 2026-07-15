import { describe, expect, it, vi } from 'vitest'
import { ArchiveRetryService } from '../../src/worker/archive-retry.service.js'

describe('ArchiveRetryService.sweepFailedArchives', () => {
  it('queries find_failed_archives and replays archiveInvoice for each row', async () => {
    const rows = [
      { tenant_id: 't1', id: 'i1' },
      { tenant_id: 't2', id: 'i2' },
    ]
    const pool = { query: vi.fn().mockResolvedValue({ rows }) }
    const archive = { archiveInvoice: vi.fn().mockResolvedValue(undefined) }
    const service = new ArchiveRetryService(pool as never, archive as never)

    const n = await service.sweepFailedArchives()

    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id, id FROM find_failed_archives($1)',
      [100],
    )
    expect(archive.archiveInvoice).toHaveBeenCalledWith('t1', 'i1')
    expect(archive.archiveInvoice).toHaveBeenCalledWith('t2', 'i2')
    expect(archive.archiveInvoice).toHaveBeenCalledTimes(2)
    expect(n).toBe(2)
  })

  it('is a no-op (returns 0) when nothing has a failed/stuck archive', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) }
    const archive = { archiveInvoice: vi.fn() }
    const service = new ArchiveRetryService(pool as never, archive as never)

    const n = await service.sweepFailedArchives()

    expect(archive.archiveInvoice).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })
})
