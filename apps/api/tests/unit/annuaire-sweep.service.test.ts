import { describe, expect, it, vi } from 'vitest'
import {
  ANNUAIRE_REPUBLISH_JOB,
  ANNUAIRE_SYNC_JOB,
} from '../../src/queue/annuaire-sync.job.js'
import { AnnuaireSweepService } from '../../src/worker/annuaire-sweep.service.js'

function build(rows: unknown[]) {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  const queue = { add: vi.fn().mockResolvedValue(undefined) }
  const service = new AnnuaireSweepService(pool as never, queue as never)
  return { service, pool, queue }
}

const TODAY_RE = /^\d{8}$/

describe('AnnuaireSweepService.sweepSync', () => {
  it('is a no-op (returns 0) when find_annuaire_sync_targets has no row', async () => {
    const { service, pool, queue } = build([])
    const n = await service.sweepSync('D')
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id FROM find_annuaire_sync_targets()',
    )
    expect(queue.add).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })

  it('enqueues one annuaire-sync job per tenant with a bounded, deterministic jobId (bucket journalier)', async () => {
    const rows = [{ tenant_id: 't1' }, { tenant_id: 't2' }]
    const { service, queue } = build(rows)

    const n = await service.sweepSync('D')

    expect(n).toBe(2)
    expect(queue.add).toHaveBeenCalledTimes(2)
    const [name1, payload1, opts1] = queue.add.mock.calls[0]!
    expect(name1).toBe(ANNUAIRE_SYNC_JOB)
    expect(payload1).toEqual({ tenantId: 't1', typeFlux: 'D' })
    expect(opts1.jobId).toMatch(/^t1:D:\d{8}$/)
    const [, payload2, opts2] = queue.add.mock.calls[1]!
    expect(payload2).toEqual({ tenantId: 't2', typeFlux: 'D' })
    expect(opts2.jobId.split(':')[2]).toMatch(TODAY_RE)
  })

  it('propage TypeFlux dans le jobId (C vs D distincts, jamais de collision)', async () => {
    const { service, queue } = build([{ tenant_id: 't1' }])
    await service.sweepSync('C')
    const [, payload, opts] = queue.add.mock.calls[0]!
    expect(payload).toEqual({ tenantId: 't1', typeFlux: 'C' })
    expect(opts.jobId.startsWith('t1:C:')).toBe(true)
  })
})

describe('AnnuaireSweepService.sweepStuckDrafts', () => {
  it('is a no-op (returns 0) when find_stale_annuaire_drafts has no row', async () => {
    const { service, pool, queue } = build([])
    const n = await service.sweepStuckDrafts()
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT tenant_id, id FROM find_stale_annuaire_drafts($1)',
      [100],
    )
    expect(queue.add).not.toHaveBeenCalled()
    expect(n).toBe(0)
  })

  it("enqueues one annuaire-republish job per stale draft, jobId = id + '-republish' (PAS ':' — BullMQ réserve ':' aux jobId à 3 segments)", async () => {
    const rows = [
      { tenant_id: 't1', id: 'ligne-1' },
      { tenant_id: 't2', id: 'ligne-2' },
    ]
    const { service, queue } = build(rows)

    const n = await service.sweepStuckDrafts()

    expect(n).toBe(2)
    expect(queue.add).toHaveBeenNthCalledWith(
      1,
      ANNUAIRE_REPUBLISH_JOB,
      { tenantId: 't1', ligneId: 'ligne-1' },
      { jobId: 'ligne-1-republish' },
    )
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      ANNUAIRE_REPUBLISH_JOB,
      { tenantId: 't2', ligneId: 'ligne-2' },
      { jobId: 'ligne-2-republish' },
    )
  })
})
